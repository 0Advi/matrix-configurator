#!/usr/bin/env bash
# Start the Matrix Configurator on localhost.
#
#   ./start.sh           NocoBase (Docker) + configurator web  → http://localhost:4300
#   ./start.sh --local   configurator web only; saves stay in this browser (localStorage)
#
# The web server runs in the foreground — Ctrl-C stops it. NocoBase keeps running
# in Docker until ./stop.sh (data is kept across restarts).
set -euo pipefail
cd "$(dirname "$0")"

LOCAL_ONLY=0
[[ "${1:-}" == "--local" ]] && LOCAL_ONLY=1

command -v node >/dev/null || { echo "✗ Node.js is required (v20+)"; exit 1; }
[[ -f .env ]] || { echo "✗ .env missing — copy .env.example to .env and fill it in (see README)"; exit 1; }

if [[ $LOCAL_ONLY -eq 0 ]]; then
  if ! docker info >/dev/null 2>&1; then
    if [[ "$(uname)" == "Darwin" ]]; then
      echo "… Docker isn't running — starting Docker Desktop"
      open -a Docker || true
      for _ in $(seq 1 36); do docker info >/dev/null 2>&1 && break; sleep 5; done
    fi
  fi
  if docker info >/dev/null 2>&1; then
    echo "… starting NocoBase + Postgres"
    docker compose up -d
    if node nocobase/scripts/wait-for-nocobase.mjs && node nocobase/scripts/provision.mjs; then
      echo "✓ NocoBase ready — admin UI http://localhost:13000 (login in .env)"
    else
      echo "⚠ NocoBase did not come up — continuing in local mode (see: docker compose logs nocobase)"
    fi
  else
    echo "⚠ Docker unavailable — continuing in local mode (browser storage only)"
  fi
fi

echo "… starting configurator web"
[[ $LOCAL_ONLY -eq 1 ]] && export CFG_MODE=local
exec node web/server.mjs
