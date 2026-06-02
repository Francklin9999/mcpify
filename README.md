# MCP Forge

**Turn any website into a runnable MCP server.** Paste a URL → MCP Forge captures the page's real
network traffic, infers action-capable tools, and emits a standalone MCP server you download and run
locally — so an LLM can actually *act* on that site, using your machine and your creds.

> Generate, don't integrate.

## What it does

1. **Capture** — a 3-tier scraper loads the page in a real browser and records its live network calls
   (XHR/fetch), DOM, and forms into a `CaptureBundle`.
2. **Infer** — a pluggable LLM reads the bundle and proposes **action-capable** tools, validated against a
   strict contract. Provider is chosen at runtime (see [LLM providers](#llm-providers)); with no key, a
   **keyless heuristic** produces a real fallback. Every server also gets a `fetch_page_content` baseline, so
   even pure content sites (Wikipedia) yield something usable.
3. **Generate** — codegen emits a **standalone installable project**: `server.ts` (MCP SDK), pinned
   `package.json`, `tsconfig.json`, an MCP-client config snippet, and install scripts. Deterministic.
4. **Drive** — every generated server ships a **persistent-session browsing toolkit**
   (`browser_navigate / snapshot / click / type / select / extract`) holding one Chromium session across
   tool calls, so an LLM can drive a real page turn-by-turn: paginate, fill forms, add to cart, multi-step
   flows. Released cleanly on shutdown so servers don't leak browsers.
5. **Keep alive** — a Go monitor health-checks servers and detects drift, enqueueing jobs; the worker
   **self-heals** (rewrites only the broken tool) or **regenerates** (re-parses wholesale) and bumps the
   version.

## Integrations & features

- **LLM providers (pluggable)** — one factory, swapped by the `LLM_PROVIDER` env var:
  **OpenAI `gpt-5.4` (default)**, **Anthropic Claude**, or **Google Gemini** — with a keyless heuristic
  fallback when no key is set. Same inference + self-heal interface for all three.
- **ElevenLabs voice** *(extension)* — talk to the side-panel agent and hear it back: **speech-to-text**
  input (Scribe) and **text-to-speech** replies (multilingual v2), with optional auto-speak. Configured in
  the extension settings.
- **Solana on-chain registry** — generated servers can be published to an on-chain registry program
  (`B6xe3XtwyokW7Nsud63otwagnJS4GMkAutWXwftMtCKh`) via the `@mcp/solana` client, giving each server a
  verifiable, discoverable record.
- **MongoDB Atlas** — a curated server catalog merged into the web library, detail pages, and downloads,
  plus a **per-domain tool cache** so repeat generations of the same site are fast.
- **Chrome extension** — see below.

## The Chrome extension

A **static MV3 extension — no build step**. Load `apps/extension` unpacked. Its side-panel chat (with voice)
does two things against the tab you're already on:

- **Drives the live page for you** — an in-browser agent loop reads the page, clicks, types, and navigates
  as your real signed-in session. Every page-changing action and every off-origin navigation **asks you to
  confirm first** (Confirm / Skip, inline).
- **Turns the page into an MCP server** — generate, then copy/download `server.ts` +
  `claude_code_config.json` straight from the chat.

## Legal modes

Generated code runs **locally** — this is a user-automation tool, not a server-side scraper. Three modes:

| Mode | Behavior | Enforced in |
|------|----------|-------------|
| `safe` (default) | Respects robots.txt, public pages, no session | scraper |
| `full_scrape` | Ignores robots.txt, public pages, user acknowledges ToS risk | scraper |
| `session` | Acts inside your own logged-in browser session | extension |

Never: store credentials server-side, scrape behind a login server-side, or bypass auth-wall CAPTCHAs.

## Monorepo

| Package | Stack | What it is |
|---------|-------|-----------|
| `packages/types` | TS + zod | **Keystone contracts** — every cross-component shape, one source |
| `packages/db` | Drizzle / Postgres | Registry schema + migrations |
| `packages/solana` | TS + web3.js | On-chain registry client (`publishServer` / `fetchRegistry`) |
| `services/scraper` | Python / Scrapling | 3-tier fetch → `CaptureBundle` (real-Chromium XHR capture) |
| `services/generator` | Node | LLM factory (OpenAI/Claude/Gemini) + codegen + self-heal + BullMQ worker |
| `services/monitor` | Go | Health + drift detection → enqueue jobs |
| `apps/web` | Next.js | Landing page + library / generate / monitor + API |
| `apps/extension` | Static MV3 | Side-panel voice chat: drive the tab + generate a server from it |
| `programs/server-registry` | Rust / Anchor | The Solana registry program |

**Data flow:** `web → BullMQ → generator worker → scraper (real browser) → codegen → Postgres + artifact
store → download`. The Go monitor feeds the same queue for self-heal.

## Configure

Copy the example env and fill in whatever you want to use — everything is optional except a provider key (or
none, for the heuristic fallback):

```bash
cp .env.example .env
```

Key surface: `LLM_PROVIDER` + `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`,
`ELEVENLABS_API_KEY`, `MONGODB_URI`, `SOLANA_RPC_URL` / `SOLANA_REGISTRY_KEYPAIR`, and the Postgres/Redis
infra URLs (defaults match docker-compose). See `.env.example` for the annotated list.

### LLM providers

| `LLM_PROVIDER` | Key | Default model |
|----------------|-----|---------------|
| `openai` (default) | `OPENAI_API_KEY` | `gpt-5.4` |
| `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `gemini` | `GEMINI_API_KEY` | `gemini-3.1-pro-preview` |
| *(none)* | — | keyless heuristic |

## Run it locally

One command brings up the whole stack (infra → migrations → scraper → worker → web):

```bash
cp .env.example .env      # add a provider key (optional)
./run.sh                  # ./run.sh --down to stop, --no-build for a fast restart
# open the API base printed at the end (default http://localhost:3001)
```

<details><summary>Manual / step-by-step</summary>

```bash
npm install
npm run build:phase0                         # build @mcp/types + @mcp/db
docker compose -f infra/docker-compose.yml up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mcp \
  node packages/db/scripts/apply-migrations.mjs

cd services/scraper && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && \
  .venv/bin/python -m playwright install chromium && \
  .venv/bin/uvicorn scraper.service:app --port 8000 &

cd ../generator && npm run build && \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/mcp REDIS_URL=redis://127.0.0.1:6379 \
  SCRAPER_URL=http://127.0.0.1:8000 ARTIFACT_ROOT=/tmp/mcp-artifacts npm run worker &

cd ../../apps/web && npm run build && \
  DATABASE_URL=... REDIS_URL=... ARTIFACT_ROOT=/tmp/mcp-artifacts npm start
```

</details>

**Chrome extension:** `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`apps/extension` (no build). API base + ElevenLabs/Atlas config sync from `mcp.config.json` / the web app.

## Production stack

The full container stack (web, generator, scraper, monitor, nginx load balancer, Postgres, Redis,
migrations, shared artifact volume) is in `infra/compose.prod.yml`:

```bash
npm run deploy:up        # open http://localhost:8080
docker compose -f infra/compose.prod.yml up -d --scale web=3 --scale generator=2 --scale scraper=2
```

The Next frontend/API also deploys to Vercel (`npm run vercel-build`); the long-running services need the
container stack or managed equivalents.

## Test

```bash
npm test                                                      # all Node unit suites (incl. extension agent loop + voice)
cd services/scraper && .venv/bin/python -m pytest             # scraper (tier-2 needs Chromium, else skips)
cd services/monitor && go test ./internal/...                 # monitor logic
bash services/generator/test/integration/run.sh               # worker (needs Redis + Postgres)
bash services/generator/test/integration/flow-a-assembled.sh  # capstone: assembled flow + real download
bash apps/web/test/smoke.sh                                   # web live smoke
```
