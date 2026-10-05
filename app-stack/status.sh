#!/usr/bin/env bash
# One-screen status of the sandbox app stack. Exit 0 only when everything is up.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
load_stack_env 2>/dev/null || true

ok=0
row() { printf '  %-12s %-6s %s\n' "$1" "$2" "$3"; [ "$2" = "up" ] || ok=1; }
http_code() { local c; c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null)"; [ "$c" = "000" ] || [ -z "$c" ] && c="no-answer"; echo "$c"; }

echo "matrix sandbox app — status"
h="$(db_health)"
if [ "$h" = "healthy" ]; then
  ledger="$(db_psql "${APP_DB_NAME:-matrix}" -tAc "SELECT count(*) FROM public.schema_migrations" 2>/dev/null || echo '?')"
  tenants="$(db_psql "${APP_DB_NAME:-matrix}" -tAc "SELECT count(*) FROM public.tenants" 2>/dev/null || echo '?')"
  row db up "127.0.0.1:${APP_DB_PORT:-54330}  container $(db_container)  ledger=${ledger} tenants=${tenants}"
else
  row db down "container status: $h"
fi

for svc in storage backend frontend; do
  case "$svc" in
    storage)  url="http://127.0.0.1:${STORAGE_PORT}/health" ;;
    backend)  url="http://127.0.0.1:${BACKEND_PORT}/api/health/db" ;;
    frontend) url="http://127.0.0.1:${FRONTEND_PORT}/" ;;
  esac
  code="$(http_code "$url")"
  if alive "$svc" && [ "$code" = "200" ]; then
    row "$svc" up "pid $(pid_of "$svc")  $url -> $code"
  else
    row "$svc" down "pid $(pid_of "$svc" || true)  $url -> $code"
  fi
done
# F4b — the configurator's design-time store (embedded at /#/admin → Workspaces).
if nocobase_up; then
  row nocobase up "http://127.0.0.1:${NOCOBASE_PORT}  (compose project matrix-configurator)"
else
  row nocobase down "http://127.0.0.1:${NOCOBASE_PORT}/api/__health_check -> no answer"
fi
h="$(cfg_health)"
if [ -n "$h" ]; then
  mode="$(printf '%s' "$h" | sed -E 's/.*"mode":"([a-z]+)".*/\1/')"
  who="pid $(pid_of configurator)"; alive configurator || who="external process"
  row configurator up "$who  http://127.0.0.1:${CFG_PORT}/cfg/health -> mode=${mode}  (proxied at http://localhost:${FRONTEND_PORT}/cfg)"
else
  row configurator down "http://127.0.0.1:${CFG_PORT}/cfg/health -> no answer"
fi
echo "  logs: app-stack/run/logs/  pidfiles: app-stack/run/*.pid"
exit $ok
