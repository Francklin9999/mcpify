# MCP Forge — auto-generate MCP servers from any website

Paste a URL → a 3-tier scraper captures the page's real network traffic → Claude (or a keyless heuristic)
infers **action-capable** tools (plus a `fetch_page_content` baseline so even pure content sites like
Wikipedia yield a usable server) → codegen emits a runnable MCP server you download and run locally.
Generated servers don't stop at one-shot calls: each ships a **persistent-session browsing toolkit**
(`browser_navigate/snapshot/click/type/select/extract`) so an LLM can drive a real page turn-by-turn —
paginate, fill forms, add to cart, multi-step flows (Skyscanner-style). A Go monitor keeps servers alive
(health-check + drift detection → self-heal/regenerate), and a **Chrome chat extension** (loads unpacked, no
build) both **drives the page you're on** (an in-browser agent loop, confirming each page-changing action)
and turns it into an MCP server from the chat.

The web app has a Jobright-inspired landing page (`/`) and the app (`/library`, `/generate`, `/monitor`):
white + green, with a first-class **dark mode** (toggle in the nav). The confidence score is the signature
visual (color = health), like Jobright's match %.

Full design: [`docs/`](./docs/) (start with `docs/00-overview.md`, then the keystone `docs/01-contracts.md`).

## Monorepo

| Package | Stack | What it is | Verified |
|---------|-------|-----------|----------|
| `packages/types` | TS + zod | **Keystone contracts** — every cross-component shape, one source | 12 unit |
| `packages/db` | Drizzle/Postgres | Registry schema + migrations | 8 unit (+ real-PG apply) |
| `services/scraper` | Python / Scrapling | 3-tier fetch → `CaptureBundle` (load-time XHR capture) | 27 (+ **real Chromium**) |
| `services/generator` | Node | Inference (+ keyless heuristic) + codegen + self-heal + **the worker** | 20 unit + 5 worker-integration |
| `services/monitor` | Go | Health/drift detect → enqueue jobs | pure + **real-PG** + Go→Node seam |
| `apps/web` | Next.js | Landing page + library/app + API (`01 §7`) + CORS | builds + **live smoke (12)** + screenshot-verified |
| `apps/extension` | Static MV3 (no build) | **Chat side panel** → drive the live tab (agent loop) + generate MCP from the page; net-intercept | loads unpacked + capture & agent-loop units (15) |

## Verification bar (honest)

- **Behavioral (real infra):** scraper (real Chromium XHR capture), worker (real Redis+Postgres: atomic
  writes, idempotency, self-heal row-level), monitor (real Postgres), web (live smoke: registry/generate/
  legal-gate/jobs/pages), and the cross-process seams (Node↔Python scraper HTTP; Go→Node→BullMQ enqueue).
- **Assembled Flow A (capstone):** `services/generator/test/integration/flow-a-assembled.sh` runs the
  whole chain with real processes — web → BullMQ → worker → scraper (real browser) → codegen → Postgres +
  shared artifact root → **downloads a real runnable MCP server**.
- **Real-site robustness:** ran the capture→generate→codegen→server pipeline against a spread of real sites
  (Wikipedia, GitHub, HN, JSON APIs, scraping-test sites, Amazon, plus hostile inputs: DNS failures, 500s,
  redirects, long paths). Generated the Wikipedia server and called `fetch_page_content` against the live
  site (real 2MB article). Fixes found & shipped from this: content sites now yield a usable server (not a
  broken zero-tool one); **duplicate tool names deduped** (a list page firing the same templated endpoint
  repeatedly no longer crashes the server); **bot walls detected and escalated to the stealth tiers**
  (Amazon-style 200-captcha pages), with graceful best-effort if all tiers are blocked.
- **Persistent-session browsing (real browser):** the generated server's browsing toolkit holds ONE Chromium
  session across tool calls; verified against **real Chromium** (`codegen.test.ts`: snapshot → click-by-ref →
  live DOM mutation), plus a fake-backend test proving state persists across separate tool calls. The session
  is released on shutdown (SIGINT/SIGTERM) so servers don't leak Chromium.
- **In-browser agent (extension):** the side-panel loop's CONTROL FLOW is unit-tested (`agent.test.ts`, 12
  tests: confirm-gating blocks a declined action, off-origin navigation confirms, multi-step result
  threading, step cap, abort). The live-tab executors and the `/api/assist` function-calling round-trip run
  only in a **loaded extension with `OPENAI_API_KEY`** — see the extension caveat below.
- **Builds + load:** web (`next build`), extension (loads unpacked — static MV3, no build step).
- **NOT verified end-to-end:** the **live-Claude inference leg** (tests use a keyless heuristic — no API
  key; the heuristic is a real no-LLM fallback); the **extension's live-tab executors + agent round-trip**
  (loaded-extension only); Tier-3 (Camoufox) is code-complete but unexercised.

## Run it locally

```bash
npm install
# Phase 0 build
npm run build --workspace=@mcp/types && npm run build --workspace=@mcp/db
# Infra
docker compose -f infra/docker-compose.yml up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mcp node packages/db/scripts/apply-migrations.mjs

# Scraper (Python)
cd services/scraper && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && \
  .venv/bin/python -m playwright install chromium && \
  .venv/bin/uvicorn scraper.service:app --port 8000 &

# Worker (consumes jobs; no ANTHROPIC_API_KEY -> keyless heuristic inference)
cd ../generator && npm run build && \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/mcp REDIS_URL=redis://127.0.0.1:6379 \
  SCRAPER_URL=http://127.0.0.1:8000 ARTIFACT_ROOT=/tmp/mcp-artifacts npm run worker &

# Web (same DATABASE_URL/REDIS_URL/ARTIFACT_ROOT)
cd ../../apps/web && npm run build && \
  DATABASE_URL=... REDIS_URL=... ARTIFACT_ROOT=/tmp/mcp-artifacts npm start
# open http://localhost:3001 — paste a URL, generate, download.
```

Set `ANTHROPIC_API_KEY` on the worker to use real Claude inference instead of the heuristic.

**Chrome extension:** `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`apps/extension` (no build needed). The extension default API base is synced from `mcp.config.json`
by `./run.sh` / `npm run sync:extension-config`. Click the icon → **Open page chat** → "Make MCP server for this page."
See [`apps/extension/README.md`](./apps/extension/README.md).

## Deployment readiness (honest assessment)

**Vercel web deployment is configured.** Keep the Vercel project root at the repository root. The root
`vercel.json` runs `npm run vercel-build`, which compiles the workspace dependencies first and then builds
`apps/web`, avoiding missing `dist` imports like `@mcp/generator/dist/...`.

Expected Vercel settings:

```bash
Root Directory: .
Build Command: npm run vercel-build
Output Directory: apps/web/.next
Install Command: npm install
```

Vercel can host the Next frontend/API routes. The long-running generator worker, scraper, monitor, Redis,
Postgres, and nginx load-balancer still need the container stack below or managed equivalents. For real
Vercel production use, point `DATABASE_URL` and `REDIS_URL` at external managed services; local Docker host
URLs will not work from Vercel.

**Container deployment is now scaffolded.** `infra/compose.prod.yml` builds Docker images for the Next web
frontend, generator worker, Python scraper, Go monitor, nginx load balancer, Postgres, Redis, migrations,
and shared artifact storage. Start the full stack with:

```bash
npm run deploy:up
# open http://localhost:8080
```

Scale the frontend and microservices with Docker Compose:

```bash
docker compose -f infra/compose.prod.yml up -d --scale web=3 --scale generator=2 --scale scraper=2
```

`load-balancer` routes public traffic to scaled `web` containers. `generator` replicas share the BullMQ
queue, `scraper` replicas are reached through Docker DNS, and `web`/`generator` share the `artifacts`
volume so downloads still work after scaling.

**Works end-to-end locally — verified.** The assembled product runs: paste a URL in the web app → job
enqueues → worker consumes → real scraper captures real network traffic (real Chromium) → codegen → the UI
job-result path returns the artifact → download a runnable MCP server. Flow B (self-heal) is verified
link-by-link (monitor produces jobs on real Postgres; Go→Node→BullMQ enqueue seam; worker self-heals on
real Postgres) but not yet as one assembled 6-process chain.

**Remaining production decisions:**

| Gap | Why it matters | Needs |
|-----|----------------|-------|
| **Auth + rate-limiting on the web API** | `/api/generate` is an **open, unauthenticated enqueue** — an abuse vector | Auth model + rate-limit policy |
| **Secrets management** | `ANTHROPIC_API_KEY`, DB/Redis creds | A secrets store for your target |
| **Real R2/S3 artifact adapter** | Only `FsArtifactStore` exists (local FS); web+worker must share storage | Implement `ArtifactStore` for object storage |
| **CI** | No automated gate | Wire the test commands below into CI |
| **Live-Claude inference** | Tests use the keyless heuristic — real inference output is **unverified** | An API key + an eval pass |
| **Legal posture** | `docs/04-legal-modes.md` raises real liability for a deployed scraper | Legal review of the scrape modes |
| **Extension in a real browser** | Loads unpacked; CORS is handled (middleware); cross-origin `fetch` from the panel is verified only as a curl preflight, not in a loaded extension | Load it, confirm the chat→generate flow live |

## Test everything

```bash
npm test                                                   # all Node unit suites (incl. extension agent-loop)
# The generator's real-browser session test runs when Playwright+Chromium are present, else skips loudly:
npm i -D playwright -w @mcp/generator && npx playwright install chromium
cd services/scraper && .venv/bin/python -m pytest          # 27 (tier-2 needs Chromium, else skips loudly)
cd services/monitor && go test ./internal/...              # pure logic
# Integration (need Docker): each prints PASS/FAIL
bash services/generator/test/integration/run.sh            # worker (Redis+Postgres)
bash services/generator/test/integration/flow-a-assembled.sh  # capstone: assembled Flow A + download
bash services/monitor/test/run-integration.sh              # monitor + Go→Node enqueue seam
bash apps/web/test/smoke.sh                                 # web live smoke
```
