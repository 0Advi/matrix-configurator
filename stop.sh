#!/usr/bin/env bash
# Stop NocoBase + Postgres. Data is KEPT (docker volumes). To wipe everything instead:
#   docker compose down -v
set -euo pipefail
cd "$(dirname "$0")"
pkill -f "node web/server.mjs" 2>/dev/null && echo "✓ web server stopped" || true
docker compose stop && echo "✓ NocoBase stopped (data kept)"
