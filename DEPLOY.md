# Deploying MCP Forge anywhere

MCP Forge is five moving parts plus two backing stores. Every link between them
is a **runtime environment variable**, so the same images deploy unchanged to
Docker, Render, Fly.io, Railway, or a bare VM — you only ever change URLs.

```
            ┌──────────┐        enqueue (Redis/BullMQ)
  browser ─▶│   web    │───────────────────────────────┐
            │ (Next)   │◀── reads Postgres + artifacts  │
            └────┬─────┘                                 ▼
                 │ DATABASE_URL / REDIS_URL        ┌───────────┐  SCRAPER_URL  ┌─────────┐
                 ▼                                 │ generator │──────────────▶│ scraper │
            ┌──────────┐   ┌────────┐              │  (worker  │               │ (Python │
            │ postgres │   │ redis  │◀─────────────│  +enqueue)│               │ Playwr.)│
            └──────────┘   └────────┘              └─────▲─────┘               └─────────┘
                 ▲                                       │ ENQUEUE_URL
                 │ DATABASE_URL                    ┌─────┴─────┐
                 └─────────────────────────────────│  monitor  │ (Go poller)
                                                   └───────────┘
```

| Service   | Lang        | Inbound port      | Reads (URLs)                              |
|-----------|-------------|-------------------|-------------------------------------------|
| web       | Next.js     | `PORT` (3001)     | `DATABASE_URL`, `REDIS_URL`, `ARTIFACT_ROOT` |
| generator | Node worker | `ENQUEUE_PORT`/`PORT` (8081) | `DATABASE_URL`, `REDIS_URL`, `SCRAPER_URL`, `ARTIFACT_ROOT` |
| scraper   | Python      | `PORT` (8000)     | —                                         |
| monitor   | Go          | none (outbound)   | `DATABASE_URL`, `ENQUEUE_URL`             |
| postgres  | —           | 5432              | —                                         |
| redis     | —           | 6379              | —                                         |

## The one rule: change the URLs, nothing else

All cross-service wiring lives in **[.env.deploy.example](.env.deploy.example)**.
Copy it, fill it in, and point `SCRAPER_URL` / `ENQUEUE_URL` / `DATABASE_URL` /
`REDIS_URL` at wherever those services actually run. That file has a per-platform
host:port cheat-sheet at the top.

## CORS: fully open everywhere

Every HTTP surface (web API, generator enqueue, scraper) sends
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: *`, all methods,
and answers `OPTIONS` preflights with `204`. No credentials are used, which is the
spec-safe "allow everything" combo (a browser rejects `*` + credentials). Any
origin — web UI, Chrome extension, curl, another deployment — can call any service.

---

## Option A — Docker / any VM (the portable baseline)

Everything (incl. Postgres, Redis, nginx) in one Compose stack:

```bash
cp .env.deploy.example .env      # fill in your API keys
npm run deploy:up                # docker compose -f infra/compose.prod.yml up -d --build
npm run deploy:logs              # tail
# UI on http://localhost:8080
npm run deploy:down
```

This is also the "any host" answer: any VPS, EC2, or PaaS that runs
`docker compose` runs this as-is. Migrations run automatically (the `migrate` step).

## Option B — Render (one-click blueprint)

1. Push to GitHub.
2. Render → **New → Blueprint** → pick this repo. It reads
   [`render.yaml`](render.yaml): web (public) + generator/scraper (private) +
   monitor (worker) + managed Postgres + Redis.
3. Fill the `mcp-secrets` group (OpenAI key etc.) when prompted.

Internal URLs are pre-wired (`http://scraper:10000`, `http://generator:10000/enqueue`)
— Render injects `PORT=10000` into all private services. Migrations run via the
web service's `preDeployCommand`.

## Option C — Fly.io (per-service apps)

One app per service; configs in [`infra/fly/`](infra/fly/). From the repo root:

```bash
# backing stores (managed)
fly postgres create --name mcp-forge-db
fly redis create                          # Upstash; note the redis:// URL

# each service (run from repo root so the Docker build context is correct)
fly deploy --config infra/fly/scraper.fly.toml
fly deploy --config infra/fly/generator.fly.toml
fly deploy --config infra/fly/monitor.fly.toml
fly deploy --config infra/fly/web.fly.toml

# wire the stores in (repeat -a for each app that needs them)
fly secrets set DATABASE_URL=postgres://... REDIS_URL=redis://... \
  OPENAI_API_KEY=sk-... -a mcp-forge-web
fly secrets set DATABASE_URL=... REDIS_URL=... OPENAI_API_KEY=... -a mcp-forge-generator
fly secrets set DATABASE_URL=... -a mcp-forge-monitor
```

Services find each other on Fly's private network at `<app>.internal:<port>`
(already set in the tomls). Run migrations once:
`fly ssh console -a mcp-forge-web -C "node packages/db/scripts/apply-migrations.mjs"`.

## Option D — Railway (per-service, from Dockerfiles)

Railway has no single multi-service blueprint file, so add each service in the
dashboard (all from this one repo):

1. **New Project → Deploy from GitHub** → this repo.
2. Add **Postgres** and **Redis** from the Railway plugin catalog.
3. Add four services, each with **Root Directory = `/`** and these settings:

   | Service   | Dockerfile Path                     | Fixed env                                   |
   |-----------|-------------------------------------|---------------------------------------------|
   | web       | `infra/docker/web.Dockerfile`       | `PORT=3001`                                  |
   | generator | `infra/docker/generator.Dockerfile` | `ENQUEUE_PORT=8081`, `SCRAPER_URL=http://scraper.railway.internal:8000` |
   | scraper   | `infra/docker/scraper.Dockerfile`   | `PORT=8000`                                  |
   | monitor   | `infra/docker/monitor.Dockerfile`   | `ENQUEUE_URL=http://generator.railway.internal:8081/enqueue` |

4. On every service, reference the stores:
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`,
   plus `OPENAI_API_KEY`, `LLM_PROVIDER=openai`, `ARTIFACT_ROOT=/data/artifacts`.
5. Generate a public domain for **web** only.
6. Run migrations once from the web service shell:
   `node packages/db/scripts/apply-migrations.mjs`.

Internal hostnames are `<service>.railway.internal` (already used above).

---

## Artifacts (generated server bundles)

`ARTIFACT_ROOT` holds the downloadable `.zip` bundles. With Docker Compose and Fly,
web + generator share one volume so downloads work end-to-end. On Render, disks
can't be shared across services — for production, set `ARTIFACT_ROOT` to object
storage (S3/R2) instead. The scrape → generate → Postgres catalog pipeline works
on every platform regardless.

## Switching a service's location later

Moved the scraper to a new host? Change `SCRAPER_URL` on the generator and redeploy
that one service. Moved the generator? Change `ENQUEUE_URL` on the monitor. Nothing
is hard-coded — that's the whole design.
