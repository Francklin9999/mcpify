#!/usr/bin/env bash
#
# run.sh - bring up the whole MCP Forge stack locally.
#
# Sequence (mirrors README "Run it locally"):
#   1. npm install + build phase-0 packages (@mcp/types, @mcp/db)
#   2. infra: docker compose up postgres + redis, wait until healthy
#   3. apply DB migrations
#   4. scraper  (Python/uvicorn)  - background
#   5. worker   (Node/BullMQ)     - background
#   6. web      (Next.js)         - foreground (Ctrl-C stops everything)
#
# Usage:
#   ./run.sh            # build + start the full stack, then open the API base from mcp.config.json
#   ./run.sh --down     # stop background services + docker infra, then exit
#   ./run.sh --no-build # skip npm install / builds (faster restart)
#
# Put OPENAI_API_KEY (and optionally OPENAI_MODEL) in a .env file at the repo
# root - copy .env.example to .env and fill in your key. With no key the worker
# falls back to the keyless heuristic (real servers, no live inference).

set -euo pipefail

# --- config ---------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DEFAULT_WEB_PROTOCOL="$(node -e "const c=require('./mcp.config.json').local; process.stdout.write(String(c.webProtocol || 'http'))")"
DEFAULT_WEB_HOST="$(node -e "const c=require('./mcp.config.json').local; process.stdout.write(String(c.webHost || 'localhost'))")"
DEFAULT_WEB_PORT="$(node -e "const c=require('./mcp.config.json').local; process.stdout.write(String(c.webPort || 3001))")"

# Load the root .env so every child (worker, web, scraper) inherits it.
# Plain Node does not read .env on its own, so we export it here for all of them.
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/mcp}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export SCRAPER_URL="${SCRAPER_URL:-http://127.0.0.1:8000}"
export ARTIFACT_ROOT="${ARTIFACT_ROOT:-/tmp/mcp-artifacts}"
export MCP_WEB_PROTOCOL="${MCP_WEB_PROTOCOL:-$DEFAULT_WEB_PROTOCOL}"
export MCP_WEB_HOST="${MCP_WEB_HOST:-$DEFAULT_WEB_HOST}"
WEB_PORT="${WEB_PORT:-${MCP_WEB_PORT:-$DEFAULT_WEB_PORT}}"
export MCP_API_BASE="${MCP_API_BASE:-$MCP_WEB_PROTOCOL://$MCP_WEB_HOST:$WEB_PORT}"

COMPOSE_FILE="$ROOT/infra/docker-compose.yml"
PIDS=()

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m==> ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- teardown -------------------------------------------------------------
# Kill a PID and all of its descendants. npm/uvicorn are wrappers that spawn
# the real server (next/worker) as a child; killing only the wrapper leaves
# the child orphaned and still holding its port, so we walk the whole tree.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

kill_matching() {
  local pattern="$1" pid
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    kill_tree "$pid"
  done
}

stop_local_processes() {
  # Clean up stale processes from a previous ./run.sh that was interrupted before its EXIT trap ran.
  kill_matching "services/generator.*npm run worker"
  kill_matching "services/generator/dist/src/main\\.js"
  kill_matching "uvicorn scraper\\.service:app"
  kill_matching "apps/web.*next start"
  kill_matching "apps/web.*next dev"
  sleep 0.4
}

port_owner() {
  local port="$1"
  if command -v ss >/dev/null; then
    ss -ltnp "sport = :$port" 2>/dev/null | awk 'NR > 1 {print; found=1} END {exit found ? 0 : 1}'
    return
  fi
  if command -v lsof >/dev/null; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print; found=1} END {exit found ? 0 : 1}'
    return
  fi
  return 1
}

port_from_url() {
  local value="$1" fallback="$2" endpoint
  endpoint="${value#*://}"
  endpoint="${endpoint%%/*}"
  if [[ "$endpoint" == *:* ]]; then
    printf '%s' "${endpoint##*:}"
    return
  fi
  printf '%s' "$fallback"
}

assert_port_free() {
  local port="$1" label="$2" owner
  [[ "$port" =~ ^[0-9]+$ ]] || die "cannot determine numeric $label port from '$port'"
  owner="$(port_owner "$port" || true)"
  if [ -n "$owner" ]; then
    warn "$label port :$port is already in use:"
    printf '%s\n' "$owner" >&2
    die "free port :$port or set the matching env var before running ./run.sh"
  fi
}

cleanup() {
  log "Shutting down background services..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
}

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

if [ "${1:-}" = "--down" ]; then
  log "Stopping local app processes..."
  stop_local_processes
  log "Stopping docker infra (postgres + redis)..."
  compose down || warn "docker compose down failed; stop Docker services manually if they are still running."
  log "Done. (Background node/python procs are tied to a running run.sh; nothing else to stop.)"
  exit 0
fi

trap cleanup EXIT INT TERM

log "Stopping stale local app processes..."
stop_local_processes

SCRAPER_PORT="$(port_from_url "$SCRAPER_URL" "8000")"
assert_port_free "$SCRAPER_PORT" "scraper"
assert_port_free "${ENQUEUE_PORT:-8081}" "worker enqueue"
assert_port_free "$WEB_PORT" "web"

# --- preflight ------------------------------------------------------------
command -v node    >/dev/null || die "node is required (>=20)"
command -v npm     >/dev/null || die "npm is required"
command -v docker  >/dev/null || die "docker is required"
command -v python3 >/dev/null || die "python3 is required (for the scraper)"

mkdir -p "$ARTIFACT_ROOT"

# --- 1. install + phase-0 build ------------------------------------------
if [ "${1:-}" != "--no-build" ]; then
  log "Installing npm workspaces..."
  npm install

  log "Building phase-0 packages (@mcp/types, @mcp/db)..."
  npm run build --workspace=@mcp/types
  npm run build --workspace=@mcp/db
else
  log "Skipping install/build (--no-build)."
fi

log "Syncing extension API default ($MCP_API_BASE)..."
node scripts/sync-extension-config.mjs

# --- 2. infra -------------------------------------------------------------
log "Starting infra (postgres + redis)..."
compose up -d

log "Waiting for postgres + redis to report healthy..."
for i in $(seq 1 60); do
  statuses="$(compose ps --format '{{.Health}}' 2>/dev/null || true)"
  if [ -n "$statuses" ] && ! grep -qvE '^(healthy)?$' <<<"$statuses"; then
    # all reported health states are "healthy" (blank = no healthcheck, treat as ok)
    if grep -q healthy <<<"$statuses"; then break; fi
  fi
  sleep 2
  [ "$i" = 60 ] && die "infra did not become healthy in time"
done
log "Infra healthy."

# --- 3. migrations --------------------------------------------------------
log "Applying DB migrations..."
node packages/db/scripts/apply-migrations.mjs

# --- 4. scraper (Python) --------------------------------------------------
log "Preparing scraper venv..."
pushd services/scraper >/dev/null
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -e '.[dev]'
  .venv/bin/python -m playwright install chromium
fi
log "Starting scraper on :$SCRAPER_PORT..."
.venv/bin/uvicorn scraper.service:app --port "$SCRAPER_PORT" &
PIDS+=($!)
popd >/dev/null

log "Waiting for scraper to answer on $SCRAPER_URL ..."
for i in $(seq 1 30); do
  if curl -sf "$SCRAPER_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  [ "$i" = 30 ] && warn "scraper not responding yet - continuing anyway"
done

# --- 5. worker (Node) -----------------------------------------------------
log "Building + starting the generator worker..."
npm run build --workspace=@mcp/generator
( cd services/generator && npm run worker ) &
PIDS+=($!)

if [ -z "${OPENAI_API_KEY:-}" ]; then
  warn "OPENAI_API_KEY not set - worker uses the keyless heuristic (no live inference). Add it to .env."
fi

# --- 6. web (Next.js) -----------------------------------------------------
log "Building web app..."
npm run build --workspace=@mcp/web

log "Starting web on $MCP_API_BASE  (Ctrl-C to stop everything)"
( cd apps/web && PORT="$WEB_PORT" npm start ) &
PIDS+=($!)

# Block here until interrupted; the EXIT/INT trap then tears down every
# service (web included) via kill_tree, so nothing is left holding a port.
wait
