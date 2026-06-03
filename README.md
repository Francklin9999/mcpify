<div align="center">

# MCP Forge

**Turn any website into a runnable MCP server.**

Capture a page's real structure and network traffic, infer action-capable tools, and emit a standalone MCP
server you run locally — so an LLM can actually *act* on that site, using your machine and your creds.

> Generate, don't integrate.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-forge?label=mcp-forge)](https://www.npmjs.com/package/mcp-forge)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org)
[![CI](https://github.com/Francklin9999/mcpify/actions/workflows/ci.yml/badge.svg)](https://github.com/Francklin9999/mcpify/actions/workflows/ci.yml)

</div>

---

## Three ways to use it

MCP Forge is **one shared core, three products** — pick the one that fits:

| | Product | Best for | Run it |
|---|---------|----------|--------|
| 🧩 | **`mcp-forge` — standalone MCP server** | Devs who want it inside Claude Code / Codex / Cursor with **zero backend, no API key** | `npx -y mcp-forge` ([guide](./services/forge-mcp-local/README.md)) |
| 🌐 | **Web app + backend microservices** | A hosted product: queue, catalog, self-healing servers, monitoring | `./run.sh` ([below](#-web-app--backend)) |
| 🧭 | **Chrome extension (MV3)** | Driving the page you're on, as your signed-in session | Load unpacked ([below](#-chrome-extension)) |

---

## 🧩 Standalone MCP server (`mcp-forge`)

A **self-contained** MCP server — no backend, no Postgres, no Redis, no Docker. One `npx`, like Playwright MCP.
By default the **host model you're already running** does the inference (no API key); optionally point it at
any provider, a local model (Ollama/LM Studio/vLLM), or your own endpoint.

```jsonc
// claude_desktop_config.json / .mcp.json / cursor settings
{
  "mcpServers": {
    "mcp-forge": {
      "command": "npx",
      "args": ["-y", "mcp-forge"]
      // No env needed by default. See the package README for provider/local/custom options.
    }
  }
}
```

Then: *"Build me an MCP server for https://rubygems.org"* → `forge_scrape` → your model designs the tools →
`forge_emit_server` writes a runnable server to disk. **Full docs:** [`services/forge-mcp-local/README.md`](./services/forge-mcp-local/README.md).

---

## 🌐 Web app + backend

The hosted product: paste a URL in the web UI, a worker pipeline generates the server, a catalog stores it,
and a Go monitor keeps generated servers healthy.

**Pipeline:** `web → BullMQ → generator worker → scraper (real browser) → codegen → Postgres + artifact store → download`. The monitor feeds the same queue for self-heal.

```bash
cp .env.example .env      # add a provider key (optional; keyless heuristic works without one)
./run.sh                  # brings up infra → migrations → scraper → worker → web
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

**Production stack** (web, generator, scraper, monitor, nginx LB, Postgres, Redis, migrations, shared artifact
volume) is in `infra/compose.prod.yml`:

```bash
npm run deploy:up        # open http://localhost:8080
docker compose -f infra/compose.prod.yml up -d --scale web=3 --scale generator=2 --scale scraper=2
```

The Next frontend/API also deploys to Vercel (`npm run vercel-build`); long-running services need the
container stack or managed equivalents. See [`DEPLOY.md`](./DEPLOY.md).

### LLM providers (web/worker)

| `LLM_PROVIDER` | Key | Default model |
|----------------|-----|---------------|
| `openai` (default) | `OPENAI_API_KEY` | `gpt-5.4` |
| `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `gemini` | `GEMINI_API_KEY` | `gemini-3.1-pro-preview` |
| *(none)* | — | keyless heuristic |

---

## 🧭 Chrome extension

A **static MV3 extension — no build step**, run locally (it talks to your running backend):

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `apps/extension`. Set the API
base URL in the extension settings.

Its side-panel chat does two things against the tab you're on:

- **Drives the live page** — an in-browser agent reads the page, clicks, types, and navigates as your real
  signed-in session. Every page-changing action and off-origin navigation **asks you to confirm first**.
- **Turns the page into an MCP server** — generate, then copy/download `server.ts` + a client config snippet
  straight from the chat.

---

## How generation works

1. **Capture** — a 3-tier scraper loads the page in a real browser and records its live network calls
   (XHR/fetch), DOM, and forms into a `CaptureBundle`. (The standalone `mcp-forge` uses a zero-dependency
   static-fetch capture by default, or a Playwright scraper via `SCRAPER_URL`.)
2. **Infer** — a pluggable brain reads the bundle and proposes **action-capable** tools, validated against a
   strict contract. With no key, a **keyless heuristic** is the floor. Every server also gets a
   `fetch_page_content` baseline, so even pure content sites yield something usable.
3. **Generate** — deterministic codegen emits a **standalone installable project**: `server.ts` (MCP SDK),
   pinned `package.json`, `tsconfig.json`, a client config snippet, and install scripts.
4. **Drive** — every generated server ships a **persistent-session browsing toolkit** (`browser_navigate /
   snapshot / click / type / select / extract`) holding one Chromium session across tool calls.
5. **Keep alive** (web product) — the Go monitor health-checks servers and detects drift; the worker
   **self-heals** (rewrites only the broken tool) or **regenerates** and bumps the version.

## Legal modes

Generated code runs **locally** — this is a user-automation tool, not a server-side scraper.

| Mode | Behavior | Enforced in |
|------|----------|-------------|
| `safe` (default) | Respects robots.txt, public pages, no session | scraper |
| `full_scrape` | Ignores robots.txt, public pages, user acknowledges ToS risk | scraper |
| `session` | Acts inside your own logged-in browser session | extension |

Never: store credentials server-side, scrape behind a login server-side, or bypass auth-wall CAPTCHAs.

## Monorepo layout

| Package | Stack | What it is |
|---------|-------|-----------|
| `packages/types` | TS + zod | **Keystone contracts** — every cross-component shape, one source |
| `packages/db` | Drizzle / Postgres | Registry schema + migrations |
| `services/scraper` | Python / Scrapling | 3-tier fetch → `CaptureBundle` (real-Chromium XHR capture) |
| `services/generator` | Node | LLM factory + codegen + self-heal + BullMQ worker (`/lean` = pure, infra-free core) |
| `services/forge-mcp-local` | Node | **`mcp-forge`** — the standalone, self-contained npx MCP server |
| `services/forge-mcp` | Node | Thin MCP client to a hosted Forge backend (`mcp-forge-remote`) |
| `services/monitor` | Go | Health + drift detection → enqueue jobs |
| `apps/web` | Next.js | Landing + library / generate / monitor + API |
| `apps/extension` | Static MV3 | Side-panel chat: drive the tab + generate a server from it |

## Configure

```bash
cp .env.example .env
```

Everything is optional except (optionally) a provider key. See `.env.example` for the annotated list and
[`DEPLOY.md`](./DEPLOY.md) for multi-platform deploys.

## Test

```bash
npm test                                                       # all Node unit suites
npm test --workspace=mcp-forge                                 # standalone MCP: providers + stdio + e2e (no key, no network)
cd services/scraper && .venv/bin/python -m pytest              # scraper (tier-2 needs Chromium, else skips)
cd services/monitor && go test ./internal/...                  # monitor logic
bash services/generator/test/integration/run.sh               # worker (needs Redis + Postgres)
```

## Contributing & security

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md). Releases are managed with
[Changesets](https://github.com/changesets/changesets).

## License

[MIT](./LICENSE) © Franck Fongang
