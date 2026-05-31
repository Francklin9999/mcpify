#!/usr/bin/env bash
# Boots ephemeral Postgres + Redis, applies the @mcp/db migration, runs the worker integration test.
set -euo pipefail
cd "$(dirname "$0")/../../../.."   # repo root

PG=mcp-itest-pg
REDIS=mcp-itest-redis
PGPORT=55440
REDISPORT=63790
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
DATABASE_URL="$DATABASE_URL" node packages/db/scripts/apply-migrations.mjs

echo "=== building generator ==="
npm run build --workspace=@mcp/generator >/dev/null

echo "=== running worker integration test ==="
node --test services/generator/dist/test/integration/*.itest.js
