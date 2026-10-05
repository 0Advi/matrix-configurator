#!/usr/bin/env bash
# Rebuild the sandbox app database from scratch (DESTROYS all sandbox app data):
#   drop/create -> Supabase shim -> schema.sql -> replay migrations -> full ledger.
# The backend is restarted afterwards (if it was running) so its startup runner
# and _verify_schema run against the fresh database.
#
#   ./reset-db.sh          interactive confirm
#   ./reset-db.sh --yes    no prompt (used by start.sh on an empty database)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ "${1:-}" = "--yes" ] || {
  read -r -p "Drop and rebuild the sandbox app database? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted"
}

[ -x "$PY" ] || die "backend venv missing — run ./start.sh first (it creates app/backend/.venv)"
[ "$(db_health)" = "healthy" ] || die "database container is not healthy (status: $(db_health)) — run ./start.sh"

was_running=0
if alive backend; then was_running=1; stop_daemon backend; fi

say "bootstrapping database (report -> app-stack/run/bootstrap/)"
"$PY" "$STACK/bootstrap/bootstrap_db.py" --report "$RUN/bootstrap" 2>&1 | grep -v '^{"ts"' | tee "$LOGS/bootstrap.log"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] || die "bootstrap failed (see app-stack/run/logs/bootstrap.log)"

if [ "$was_running" = 1 ]; then
  say "restarting backend"
  "$STACK/start.sh" --no-frontend >/dev/null
  alive backend && say "backend back up" || warn "backend did not come back — see app-stack/run/logs/backend.log"
fi
say "done"
