#!/usr/bin/env bash
# CAPSTONE: assembled Flow A end-to-end with REAL processes (inference = keyless heuristic; that leg only
# is mocked). web -> BullMQ -> real worker -> real scraper(HTTP, real Chromium) -> codegen -> Postgres +
# shared artifact root -> DOWNLOAD the generated server. Proves the assembled product AND the download
# deliverable + the cross-process artifact seam.
set -euo pipefail
cd "$(dirname "$0")/../../../.."   # repo root

PG=flowa-pg; REDIS=flowa-redis
PGPORT=55443; REDISPORT=63794; PAGEPORT=58200; SCRAPERPORT=58210; WEBPORT=3092; ENQPORT=8082
ARTIFACT_ROOT="$(mktemp -d)"; PAGEDIR="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; rm -rf "$ARTIFACT_ROOT" "$PAGEDIR"; }
trap cleanup EXIT; cleanup

# ── fixture SPA whose JS fires a load-time XHR (tier-2 captures it -> heuristic builds an http tool) ──
mkdir -p "$PAGEDIR/api"
cat > "$PAGEDIR/index.html" <<'HTML'
<!doctype html><html><head><title>Flow A SPA</title></head><body><div id=o>loading…</div>
<script>fetch('/api/items.json').then(r=>r.json()).then(d=>{document.getElementById('o').textContent='item '+d.id})</script>
</body></html>
HTML
echo '{"id":1,"name":"thing","price":9}' > "$PAGEDIR/api/items.json"

docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mcp -p $PGPORT:5432 postgres:16-alpine >/dev/null
docker run -d --rm --name "$REDIS" -p $REDISPORT:6379 redis:7-alpine >/dev/null
export DATABASE_URL="postgres://postgres:pw@127.0.0.1:$PGPORT/mcp"
export REDIS_URL="redis://127.0.0.1:$REDISPORT"
for i in $(seq 1 30); do docker exec "$PG" pg_isready -U postgres -d mcp >/dev/null 2>&1 && break; sleep 1; done

echo "=== migrate + build ==="
node packages/db/scripts/apply-migrations.mjs
npm run build --workspace=@mcp/generator >/dev/null

PAGEURL="http://127.0.0.1:$PAGEPORT/"

echo "=== start page server, scraper, worker, web ==="
python3 -m http.server "$PAGEPORT" --directory "$PAGEDIR" >/dev/null 2>&1 & PIDS+=($!)
( cd services/scraper && .venv/bin/uvicorn scraper.service:app --host 127.0.0.1 --port "$SCRAPERPORT" >/tmp/flowa-scraper.log 2>&1 ) & PIDS+=($!)
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" SCRAPER_URL="http://127.0.0.1:$SCRAPERPORT" \
  ARTIFACT_ROOT="$ARTIFACT_ROOT" ENQUEUE_PORT="$ENQPORT" \
  node services/generator/dist/src/main.js >/tmp/flowa-worker.log 2>&1 & PIDS+=($!)
( cd apps/web && DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" ARTIFACT_ROOT="$ARTIFACT_ROOT" \
  npx next start -p "$WEBPORT" >/tmp/flowa-web.log 2>&1 ) & PIDS+=($!)

for i in $(seq 1 50); do curl -fsS "http://127.0.0.1:$SCRAPERPORT/healthz" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$WEBPORT/" >/dev/null 2>&1 && break; sleep 0.5; done
BASE="http://127.0.0.1:$WEBPORT"

echo "=== web POST /api/generate ($PAGEURL) ==="
JOB=$(curl -fsS -X POST "$BASE/api/generate" -H 'content-type: application/json' -d "{\"url\":\"$PAGEURL\",\"legalMode\":\"safe\"}")
echo "  enqueued: $JOB"
JOBID=$(echo "$JOB" | sed -E 's/.*"jobId":"([^"]+)".*/\1/')

echo "=== poll for the worker-written server row (browser capture is slow) ==="
SERVERID=""
for i in $(seq 1 90); do
  SERVERID=$(docker exec "$PG" psql -U postgres -d mcp -tAc "SELECT server_id FROM servers WHERE url='$PAGEURL' AND status='active' LIMIT 1" 2>/dev/null | tr -d '[:space:]')
  [ -n "$SERVERID" ] && break
  sleep 1
done
[ -n "$SERVERID" ] || { echo "FAIL: no active server row after 90s"; echo "--- worker log ---"; tail -20 /tmp/flowa-worker.log; exit 1; }
echo "  worker produced server: $SERVERID"

TOOLCOUNT=$(docker exec "$PG" psql -U postgres -d mcp -tAc "SELECT tool_count FROM server_versions WHERE server_id='$SERVERID' AND version=1" | tr -d '[:space:]')
echo "  tools generated: $TOOLCOUNT"
[ "${TOOLCOUNT:-0}" -ge 1 ] || { echo "FAIL: expected >=1 tool from the captured XHR"; exit 1; }

echo "=== UI job-result path: GET /api/jobs/:id returns done + artifact (what GeneratePanel polls) ==="
JOBRES=$(curl -fsS "$BASE/api/jobs/$JOBID")
echo "$JOBRES" | grep -q '"status":"done"' || { echo "FAIL: job not done via /api/jobs: $JOBRES"; exit 1; }
echo "$JOBRES" | grep -q "configSnippet" || { echo "FAIL: /api/jobs result missing the artifact/configSnippet"; exit 1; }
echo "  ok: the UI polling path returns the finished artifact"

echo "=== DOWNLOAD the generated server (the deliverable) ==="
DL=$(curl -fsS "$BASE/api/servers/$SERVERID/download/1")
echo "$DL" | grep -q "server.ts" || { echo "FAIL: download missing server.ts"; echo "$DL" | head -c 400; exit 1; }
echo "$DL" | grep -q "McpServer\|registerTool" || { echo "FAIL: server.ts is not a real MCP server"; exit 1; }
echo "$DL" | grep -q "claude_desktop_config.json" || { echo "FAIL: download missing config snippet"; exit 1; }
echo "  ok: download returned a real, runnable MCP server + config"

echo "=== SAVED & visible: the generated server shows up in the Library (same DB) ==="
REG=$(curl -fsS "$BASE/api/registry")
echo "$REG" | grep -q "$SERVERID" || { echo "FAIL: generated server not in /api/registry"; echo "$REG" | head -c 300; exit 1; }
curl -fsS "$BASE/library" | grep -q "$PAGEURL" || { echo "FAIL: generated server not rendered on /library"; exit 1; }
echo "  ok: generated server is persisted and listed in the Library"

echo "ASSEMBLED FLOW A PASSED: paste URL -> generate -> worker -> scraper -> codegen -> download + saved in Library"
