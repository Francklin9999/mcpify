# Deployment

This directory has two Compose stacks:

- `docker-compose.yml`: local Postgres/Redis only for development.
- `compose.prod.yml`: full deployable stack with Docker images for web, generator worker, scraper, monitor, nginx load balancer, Postgres, Redis, migrations, and shared artifact storage.

## Start Everything

```bash
docker compose -f infra/compose.prod.yml up -d --build
```

Open `http://localhost:8080`. Set `HTTP_PORT=80` if you want nginx on port 80.

The `migrate` container runs `packages/db/scripts/apply-migrations.mjs` once before `web` and `generator` start.

## Scale Services

```bash
docker compose -f infra/compose.prod.yml up -d --scale web=3 --scale generator=2 --scale scraper=2
```

- `load-balancer` proxies all public traffic to the scaled `web` service.
- `generator` replicas all consume the same BullMQ queue, so job throughput scales horizontally.
- `scraper` replicas sit behind Docker DNS; generator calls `http://scraper:8000`.
- Keep `monitor=1` unless you intentionally want duplicate polling sweeps.

## Operations

```bash
docker compose -f infra/compose.prod.yml ps
docker compose -f infra/compose.prod.yml logs -f load-balancer web generator scraper monitor
docker compose -f infra/compose.prod.yml down
```

Persistent data lives in named Docker volumes:

- `mcp-forge_postgres_data`
- `mcp-forge_redis_data`
- `mcp-forge_artifacts`

## Required Environment

The stack works without an LLM key by falling back to heuristic generation, but production quality generation needs one provider configured in `.env`:

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=...
```

Optional provider variables from the root `.env.example` are passed through to the web and generator containers.
