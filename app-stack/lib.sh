# shellcheck shell=bash
# Shared helpers for app-stack/*.sh. Source, don't execute.

STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$STACK")"
APP="$ROOT/app"
BACKEND="$APP/backend"
FRONTEND="$APP/frontend"
RUN="$STACK/run"
LOGS="$RUN/logs"
PY="$BACKEND/.venv/bin/python"
COMPOSE_PROJECT="matrix-app"
RAW_DOCKER_SOCK="$HOME/Library/Containers/com.docker.docker/Data/docker.raw.sock"

BACKEND_PORT=8000
FRONTEND_PORT=5173
STORAGE_PORT=54331
# F4b: the Workspace Configurator's design-time store, embedded in the app at /#/admin →
# Workspaces. NocoBase = the project root's compose project `matrix-configurator`; the
# configurator server (web/server.mjs) serves /cfg on 4300 and the app's Vite proxies /cfg to it.
CFG_PORT="${CFG_PORT:-4300}"   # override only for testing; the Vite /cfg proxy targets 4300 (CFG_PROXY_TARGET)
NOCOBASE_PORT=13000

mkdir -p "$RUN" "$LOGS"

say()  { printf '\033[1m[app-stack]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[app-stack] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[app-stack] %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose -p "$COMPOSE_PROJECT" -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" "$@"; }

db_container() { echo "${COMPOSE_PROJECT}-db-1"; }

# healthy | starting | unhealthy (running) — or the container state (created, exited, ...) — or absent
db_health() { docker inspect -f '{{if eq .State.Status "running"}}{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}{{else}}{{.State.Status}}{{end}}' "$(db_container)" 2>/dev/null || echo "absent"; }

# psql inside the db container (no host psql needed). Usage: db_psql <db> -c "..."
db_psql() {
  local db="$1"; shift
  docker exec -i "$(db_container)" psql -X -v ON_ERROR_STOP=1 -U "${APP_DB_USER:-postgres}" -d "$db" "$@"
}

load_stack_env() { set -a; # shellcheck disable=SC1091
  . "$STACK/.env"; set +a; }

pid_of() { local f="$RUN/$1.pid"; [ -f "$f" ] && cat "$f" || true; }
alive()  { local p; p="$(pid_of "$1")"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

# start_daemon <name> <cwd> <cmd...> — detached, pidfile + log under run/
start_daemon() {
  local name="$1" cwd="$2"; shift 2
  if alive "$name"; then say "$name already running (pid $(pid_of "$name"))"; return 0; fi
  # `exec` so $! is the service itself (not a wrapper shell), and every fd is
  # redirected so the daemon never holds the caller's stdout/stderr open.
  ( cd "$cwd" || exit 1; exec nohup "$@" ) </dev/null >>"$LOGS/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
  disown 2>/dev/null || true
  say "$name started (pid $(pid_of "$name")), log: app-stack/run/logs/$name.log"
}

stop_daemon() {
  local name="$1" p
  p="$(pid_of "$name")"
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    say "$name stopped (pid $p)"
  else
    say "$name not running"
  fi
  rm -f "$RUN/$name.pid"
}

# wait_http <url> <seconds> — 0 once the URL returns 2xx
wait_http() {
  local url="$1" secs="${2:-60}" i
  for i in $(seq 1 "$((secs * 2))"); do
    curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# F4b — configurator / NocoBase helpers
cfg_health()      { curl -fsS --max-time 3 "http://127.0.0.1:${CFG_PORT}/cfg/health" 2>/dev/null || true; }
nocobase_up()     { curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${NOCOBASE_PORT}/api/__health_check" 2>/dev/null; }
nocobase_compose() { (cd "$ROOT" && docker compose "$@"); }
