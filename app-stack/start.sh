#!/usr/bin/env bash
# Start the Matrix sandbox app on localhost. Idempotent: anything already up is left alone.
#
#   db        Postgres 16 (docker compose project `matrix-app`) on 127.0.0.1:54330
#   storage   Supabase-Storage stub (node)                     on 127.0.0.1:54331
#   backend   FastAPI / uvicorn                                 on http://localhost:8000
#   frontend  Vite dev server                                   on http://localhost:5173
#
# First run also: generates local env files with fresh secrets, creates the backend
# venv (python3.12), runs `npm ci`, and bootstraps the empty database (reset-db.sh).
#
#   configurator  NocoBase (compose project `matrix-configurator`, :13000) + configurator
#                 server web/server.mjs (/cfg on :4300) — the design-time store of the
#                 configurator embedded at /#/admin → Workspaces (F4b)
#
#   ./start.sh                     everything
#   ./start.sh --no-frontend       db + storage + backend (+ configurator)
#   ./start.sh --no-configurator   skip NocoBase + the :4300 server (the embedded configurator
#                                  then keeps drafts in the browser only)
#   BACKEND_RELOAD=1 ./start.sh   uvicorn --reload (handy while editing app/backend)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

WITH_FRONTEND=1
WITH_CONFIGURATOR=1
for a in "$@"; do
  case "$a" in
    --no-frontend) WITH_FRONTEND=0 ;;
    --no-configurator) WITH_CONFIGURATOR=0 ;;
    *) die "unknown flag: $a" ;;
  esac
done

# ── 0. env files + toolchains ────────────────────────────────────────────────
python3 "$STACK/bootstrap/gen_env.py"
load_stack_env

if [ ! -x "$PY" ]; then
  PYBIN="$(command -v python3.12 || command -v python3.13 || command -v python3)"
  say "creating backend venv with $PYBIN"
  "$PYBIN" -m venv "$BACKEND/.venv"
  "$BACKEND/.venv/bin/pip" install -q -U pip
  "$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.lock.txt"
  "$BACKEND/.venv/bin/pip" install -q --no-deps -e "$BACKEND"
fi
# Re-sync the venv when requirements.lock.txt changed since the last install (F4a added
# jsonschema + its pinned deps; an existing venv would otherwise miss them).
lock_sha="$(shasum -a 256 "$BACKEND/requirements.lock.txt" | cut -d' ' -f1)"
if [ "$(cat "$BACKEND/.venv/.lock-sha256" 2>/dev/null)" != "$lock_sha" ]; then
  say "backend requirements.lock.txt changed — syncing the venv"
  "$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.lock.txt" && echo "$lock_sha" >"$BACKEND/.venv/.lock-sha256"
fi
if [ "$WITH_FRONTEND" = 1 ] && [ ! -d "$FRONTEND/node_modules" ]; then
  say "npm ci (frontend)"
  (cd "$FRONTEND" && npm ci --no-audit --no-fund)
fi

# ── 1. database ──────────────────────────────────────────────────────────────
docker info >/dev/null 2>&1 || die "Docker is not running — start Docker Desktop first."
if [ "$(db_health)" != "healthy" ]; then
  say "starting database container ($COMPOSE_PROJECT)"
  # `compose up` can block indefinitely if Docker Desktop is wedged; run it in the
  # background and poll health with our own deadline instead.
  compose up -d db >>"$LOGS/compose.log" 2>&1 &
  cpid=$!
  for i in $(seq 1 90); do
    [ "$(db_health)" = "healthy" ] && break
    # Fallback for a wedged Docker Desktop API proxy (seen 2026-10-04: every
    # container start hung in 'created' behind a pending file-sharing approval).
    # Starting through the raw daemon socket bypasses the proxy; host port
    # publishing still works.
    st="$(db_health)"
    if [ "$i" = 20 ] && { [ "$st" = "created" ] || [ "$st" = "exited" ]; } && [ -S "$RAW_DOCKER_SOCK" ]; then
      warn "container still '$st' after 20s — starting it via the raw Docker socket (Docker Desktop API proxy looks wedged)"
      DOCKER_HOST="unix://$RAW_DOCKER_SOCK" docker start "$(db_container)" >>"$LOGS/compose.log" 2>&1 || true
    fi
    sleep 1
  done
  if [ "$(db_health)" != "healthy" ]; then
    kill "$cpid" 2>/dev/null || true
    die "database did not become healthy within 90s (status: $(db_health)). If it is stuck in 'created',
     Docker Desktop is not starting containers — check for a pending macOS permission prompt or restart Docker Desktop."
  fi
  # Don't block on compose itself: with a wedged proxy it never returns even
  # though the container is up.
  if kill -0 "$cpid" 2>/dev/null; then kill "$cpid" 2>/dev/null || true; fi
  wait "$cpid" 2>/dev/null || true
fi
say "database healthy on 127.0.0.1:${APP_DB_PORT}"

# Bootstrap if the app database is missing or has no migration ledger.
has_ledger="$(db_psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${APP_DB_NAME}'" 2>/dev/null || true)"
if [ "$has_ledger" = "1" ]; then
  has_ledger="$(db_psql "$APP_DB_NAME" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL AND to_regclass('public.tenants') IS NOT NULL" 2>/dev/null || true)"
fi
if [ "$has_ledger" != "t" ]; then
  say "database is empty — bootstrapping"
  "$STACK/reset-db.sh" --yes
fi

# ── 2. storage stub ──────────────────────────────────────────────────────────
if ! alive storage; then
  port_busy "$STORAGE_PORT" && die "port $STORAGE_PORT is in use by another process"
  start_daemon storage "$STACK" node "$STACK/storage-stub.mjs"
  wait_http "http://127.0.0.1:${STORAGE_PORT}/health" 15 || die "storage stub failed — see app-stack/run/logs/storage.log"
fi

# ── 3. backend ───────────────────────────────────────────────────────────────
if ! alive backend; then
  port_busy "$BACKEND_PORT" && die "port $BACKEND_PORT is in use by another process"
  reload=(); [ "${BACKEND_RELOAD:-0}" = 1 ] && reload=(--reload --reload-dir "$BACKEND/app")
  start_daemon backend "$BACKEND" "$BACKEND/.venv/bin/uvicorn" app.main:app \
    --host 127.0.0.1 --port "$BACKEND_PORT" ${reload[@]+"${reload[@]}"}
  if ! wait_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 60; then
    tail -n 30 "$LOGS/backend.log" >&2 || true
    die "backend failed to start — see app-stack/run/logs/backend.log"
  fi
fi
curl -fsS --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/health/db" >/dev/null \
  && say "backend healthy: http://localhost:${BACKEND_PORT}/api/health (+ /api/health/db)" \
  || warn "backend up but /api/health/db failed"

# ── 4. configurator design-time store (F4b) ──────────────────────────────────
# Started before the frontend so the Vite /cfg proxy has a target. Never fatal: without it the
# embedded configurator still works and keeps drafts in the browser (local mode).
if [ "$WITH_CONFIGURATOR" = 1 ]; then
  if [ -n "$(cfg_health)" ]; then
    say "configurator server already answering on :${CFG_PORT} ($(cfg_health | sed -E 's/.*"mode":"([a-z]+)".*/mode=\1/'))"
  else
    if [ ! -f "$ROOT/.env" ]; then
      warn "no $ROOT/.env (NocoBase settings) — the configurator server will run in local mode"
    elif nocobase_up; then
      say "NocoBase already up on :${NOCOBASE_PORT}"
    else
      say "starting NocoBase (compose project matrix-configurator; first boot can take minutes)"
      nocobase_compose up -d >>"$LOGS/nocobase.log" 2>&1 || warn "docker compose up for NocoBase failed — see app-stack/run/logs/nocobase.log"
      if (cd "$ROOT" && node nocobase/scripts/wait-for-nocobase.mjs --timeout=300 && node nocobase/scripts/provision.mjs) >>"$LOGS/nocobase.log" 2>&1; then
        say "NocoBase ready on :${NOCOBASE_PORT}"
      else
        warn "NocoBase did not come up — the configurator server starts in local mode (see app-stack/run/logs/nocobase.log)"
      fi
    fi
    if port_busy "$CFG_PORT"; then
      warn "port $CFG_PORT is in use by something that is not the configurator server — skipping it"
    else
      start_daemon configurator "$ROOT" env WEB_PORT="$CFG_PORT" node "$ROOT/web/server.mjs"
      wait_http "http://127.0.0.1:${CFG_PORT}/cfg/health" 30 \
        && say "configurator server: http://127.0.0.1:${CFG_PORT}/cfg/health ($(cfg_health | sed -E 's/.*"mode":"([a-z]+)".*/mode=\1/'))" \
        || warn "configurator server did not answer — see app-stack/run/logs/configurator.log"
    fi
  fi
fi

# ── 5. frontend ──────────────────────────────────────────────────────────────
if [ "$WITH_FRONTEND" = 1 ] && ! alive frontend; then
  port_busy "$FRONTEND_PORT" && die "port $FRONTEND_PORT is in use by another process"
  start_daemon frontend "$FRONTEND" node "$FRONTEND/node_modules/vite/bin/vite.js" \
    --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort
  wait_http "http://127.0.0.1:${FRONTEND_PORT}/" 60 || die "frontend failed — see app-stack/run/logs/frontend.log"
  say "frontend: http://localhost:${FRONTEND_PORT}  (HashRouter: platform admin = http://localhost:${FRONTEND_PORT}/#/admin → Workspaces)"
fi

"$STACK/status.sh"
