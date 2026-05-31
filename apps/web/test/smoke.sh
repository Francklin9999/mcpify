#!/usr/bin/env bash
# Live smoke test: real Postgres + Redis, seed servers, start `next start`, exercise the real routes.
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

PG=web-smoke-pg
REDIS=web-smoke-redis
PGPORT=55442
REDISPORT=63793
WEBPORT=3091
WEBPID=""
cleanup() { [ -n "$WEBPID" ] && kill "$WEBPID" 2>/dev/null || true; docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mcp -p $PGPORT:5432 postgres:16-alpine >/dev/null
docker run -d --rm --name "$REDIS" -p $REDISPORT:6379 redis:7-alpine >/dev/null
export DATABASE_URL="postgres://postgres:pw@127.0.0.1:$PGPORT/mcp"
export REDIS_URL="redis://127.0.0.1:$REDISPORT"
for i in $(seq 1 30); do docker exec "$PG" pg_isready -U postgres -d mcp >/dev/null 2>&1 && break; sleep 1; done

echo "=== migrate + seed ==="
node packages/db/scripts/apply-migrations.mjs
docker exec -i "$PG" psql -U postgres -d mcp >/dev/null <<SQL
INSERT INTO servers (server_id, url, title, tier, confidence, install_count, status, current_version, last_parsed_at)
VALUES ('11111111-1111-4111-8111-111111111111','https://example.com/products','Example Products','curated',0.97,1284,'active',4, now()),
       ('22222222-2222-4222-8222-222222222222','https://docs.example.dev','Docs Search','auto_gen',0.66,40,'degraded',2, now());
INSERT INTO server_versions (server_id, version, artifact_url, tool_count, created_by)
VALUES ('11111111-1111-4111-8111-111111111111',4,'file:///x/4.zip',6,'auto');
SQL

echo "=== start next ==="
( cd apps/web && PORT=$WEBPORT DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" npx next start -p $WEBPORT >/tmp/web-smoke.log 2>&1 ) &
WEBPID=$!
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$WEBPORT/" >/dev/null 2>&1 && break; sleep 0.5; done

BASE="http://127.0.0.1:$WEBPORT"
fail() { echo "SMOKE FAIL: $1"; exit 1; }

echo "=== GET /api/registry ==="
REG=$(curl -fsS "$BASE/api/registry")
echo "$REG" | grep -q "Example Products" || fail "registry missing seeded server"
echo "$REG" | grep -q "Docs Search" || fail "registry missing second server"
echo "  ok: registry returned seeded servers"

echo "=== GET /api/registry?tier=curated (filter) ==="
curl -fsS "$BASE/api/registry?tier=curated" | grep -q "Example Products" || fail "tier filter broke"
curl -fsS "$BASE/api/registry?tier=curated" | grep -q "Docs Search" && fail "tier filter did not exclude auto_gen" || true
echo "  ok: tier filter works"

echo "=== POST /api/generate (enqueue) ==="
JOB=$(curl -fsS -X POST "$BASE/api/generate" -H 'content-type: application/json' -d '{"url":"https://news.example.com","legalMode":"safe"}')
echo "$JOB" | grep -q '"jobId"' || fail "generate did not return a jobId: $JOB"
JOBID=$(echo "$JOB" | sed -E 's/.*"jobId":"([^"]+)".*/\1/')
echo "  ok: enqueued jobId=$JOBID"

echo "=== POST /api/generate rejects full_scrape without ack (04) ==="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/generate" -H 'content-type: application/json' -d '{"url":"https://x.com","legalMode":"full_scrape"}')
[ "$CODE" = "400" ] || fail "full_scrape without ack should 400, got $CODE"
echo "  ok: full_scrape gated (400)"

echo "=== GET /api/jobs/:id ==="
curl -fsS "$BASE/api/jobs/$JOBID" | grep -qE '"status"' || fail "job status route broken"
echo "  ok: job status route works"

echo "=== GET / (landing page renders) ==="
LANDING=$(curl -fsS "$BASE/")
echo "$LANDING" | grep -qi "MCP server" || fail "landing page did not render hero"
echo "$LANDING" | grep -qi "Generate" || fail "landing page missing CTA"
echo "  ok: landing page renders (hero + CTA)"

echo "=== GET /library (library renders cards) ==="
curl -fsS "$BASE/library" | grep -q "Example Products" || fail "library page did not render server"
echo "  ok: library page renders"

echo "=== GET /servers/:id (detail) ==="
curl -fsS "$BASE/servers/11111111-1111-4111-8111-111111111111" | grep -q "Example Products" || fail "detail page broke"
echo "  ok: detail page renders"

echo "=== CORS preflight (extension origin) ==="
CORS=$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/api/generate" -H 'Origin: chrome-extension://abc' -H 'Access-Control-Request-Method: POST')
echo "$CORS" | grep -qi "access-control-allow-origin" || fail "no CORS header on preflight"
echo "  ok: CORS preflight returns allow-origin (extension can call the API)"

echo "=== POST /api/assist (no-key fallback) ==="
ASSIST=$(curl -fsS -X POST "$BASE/api/assist" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"what tools does this have?"}]}')
echo "$ASSIST" | grep -qi "tool" || fail "assist fallback returned nothing useful: $ASSIST"
echo "  ok: assist responds (no-key fallback)"

echo "=== POST /api/servers/:id/contribute (CaptureBundle) ==="
BUNDLE=$(cat fixtures/capture-bundles/sample-public.json)
CCODE=$(curl -s -o /tmp/contrib.json -w '%{http_code}' -X POST "$BASE/api/servers/11111111-1111-4111-8111-111111111111/contribute" \
  -H 'content-type: application/json' -d "{\"bundle\":$BUNDLE}")
[ "$CCODE" = "202" ] || fail "contribute should 202, got $CCODE: $(cat /tmp/contrib.json)"
grep -q "pending" /tmp/contrib.json || fail "contribute did not return pending"
echo "  ok: contribute accepted (pending)"

echo "ALL WEB SMOKE CHECKS PASSED"
