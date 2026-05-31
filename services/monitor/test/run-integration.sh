#!/usr/bin/env bash
# Monitor integration: real Postgres (store + poller behavioral test) + Go->Node->BullMQ enqueue seam.
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

PG=mon-itest-pg
REDIS=mon-itest-redis
PGPORT=55441
REDISPORT=63791
cleanup() { docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mcp -p $PGPORT:5432 postgres:16-alpine >/dev/null
docker run -d --rm --name "$REDIS" -p $REDISPORT:6379 redis:7-alpine >/dev/null
export DATABASE_URL="postgres://postgres:pw@127.0.0.1:$PGPORT/mcp"
export REDIS_HOST=127.0.0.1
export REDIS_PORT=$REDISPORT
for i in $(seq 1 30); do docker exec "$PG" pg_isready -U postgres -d mcp >/dev/null 2>&1 && break; sleep 1; done

echo "=== applying migration ==="
node packages/db/scripts/apply-migrations.mjs

echo "=== monitor store/poller integration test (real Postgres) ==="
( cd services/monitor && DATABASE_URL="$DATABASE_URL" go test ./internal/monitor/ -run TestMonitorAgainstRealPostgres -v 2>&1 | tail -8 )

echo "=== Go -> Node enqueue seam (real BullMQ) ==="
npm run build --workspace=@mcp/generator >/dev/null
node services/generator/test/integration/enqueue-seam-check.mjs
