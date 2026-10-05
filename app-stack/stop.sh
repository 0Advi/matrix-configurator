#!/usr/bin/env bash
# Stop the sandbox app. Data is KEPT (the Postgres volume survives).
#
#   ./stop.sh                  frontend + backend + storage stub + configurator server + db container
#   ./stop.sh --apps           frontend + backend + storage stub + configurator server (db keeps running)
#   ./stop.sh --with-nocobase  also stop NocoBase (compose project matrix-configurator; data kept).
#                              Left running by default: the stand-alone configurator (../start.sh) uses it too.
#
# The configurator server is stopped only if this stack started it (pidfile); one started by the
# project-root ./start.sh in a terminal is left alone.
# Wipe everything instead: ./stop.sh && docker compose -p matrix-app down -v
set -euo pipefail
. "$(dirname "$0")/lib.sh"

APPS_ONLY=0; WITH_NOCOBASE=0
for a in "$@"; do
  case "$a" in
    --apps) APPS_ONLY=1 ;;
    --with-nocobase) WITH_NOCOBASE=1 ;;
    *) die "unknown flag: $a" ;;
  esac
done

stop_daemon frontend
stop_daemon backend
stop_daemon storage
stop_daemon configurator

if [ "$WITH_NOCOBASE" = 1 ] && docker info >/dev/null 2>&1; then
  nocobase_compose stop >/dev/null 2>&1 && say "NocoBase stopped (volumes kept)" || warn "could not stop NocoBase"
fi

if [ "$APPS_ONLY" != 1 ]; then
  if docker info >/dev/null 2>&1; then
    compose stop db >/dev/null 2>&1 && say "database container stopped (volume kept)" || warn "could not stop database container"
  fi
fi
