# 00 — Overview, Repo Layout & Build Order

## The product

Three product surfaces, one system. They form a funnel; the side panel is the long-term product.

| Surface | User | Action | Auth |
|---------|------|--------|------|
| **Web app** (Next.js) | Developer | Paste URL → detect tools → download server code + config snippet | none |
| **Extension popup** (Plasmo) | Power user | One-click generate on current tab | inherits browser session |
| **Side panel** (TypeScript) | Everyone | LLM chat about current page; autocomplete page actions; silent network capture | inherits browser session |

## What is novel (and what is not)

- **Not novel:** the hub/registry (commodity), site→content extraction (SiteMCP already exists).
- **The gap we fill:** auto-generate **action-capable** MCP servers from **real network traffic**,
  keep them alive with **self-healing**, and let the community **graduate** auto-gen servers to curated.

## The stack, one line per layer

| Layer | Tech | Responsibility |
|-------|------|----------------|
| Scraping | Scrapling (Python) `[fetchers]` — `Fetcher` / `DynamicFetcher` / `StealthyFetcher` | 3-tier fetch + load-time XHR capture + adaptive healing |
| Generation | Node + `@modelcontextprotocol/sdk` + Claude API | Tool inference + codegen + self-heal |
| Monitoring | Go | Cheap concurrent polling; never touches a browser |
| Queue | BullMQ on Redis | Go pushes jobs, Node consumes |
| Extension | TypeScript + Plasmo; `chrome.webRequest` intercept | Surfaces + capture source |
| Data | Postgres + Redis + R2 | Registry/versions + cache/queue + code artifacts |
| Web app | Next.js + shadcn/ui | Developer entry + library UI |

## Monorepo layout (Turborepo)

```
mcp/
├── apps/
│   ├── web/                 # Next.js — developer entry + registry/library UI   → apps/web.md
│   └── extension/           # Plasmo — popup + side panel + net-intercept       → apps/extension.md
├── services/
│   ├── scraper/             # Python — Scrapling 3-tier fetcher                  → services/scraper.md
│   ├── generator/           # Node — inference + codegen + self-healer          → services/generator.md
│   └── monitor/             # Go — health check + change detect + enqueue       → services/monitor.md
├── packages/
│   ├── types/               # SHARED CONTRACTS — see 01-contracts.md (keystone)
│   ├── db/                  # Drizzle schema + migrations — see 02-data-model.md
│   └── config/              # shared tsconfig / eslint / env schema
├── infra/                   # docker-compose (postgres, redis), R2 bindings
└── docs/                    # this plan
```

`packages/types` is consumed by `web`, `extension`, `generator` (TS). The Python `scraper` and Go
`monitor` **mirror** these contracts (generated or hand-kept) — see `01-contracts.md` §Cross-language.

## Build order (decoupled ≠ orderless)

Decoupling lets services be built *in parallel*, but only **after** the contracts and storage exist.

```
Phase 0 (blocking, do first, sequentially):
   packages/types  (01-contracts)  ──►  packages/db  (02-data-model)
                                          │
Phase 1 (parallel — each builds against fixtures, no other service running):
   ┌─────────────┬──────────────┬─────────────┬──────────┬───────────────┐
   scraper      generator       monitor        web         extension
   (fixtures:   (fixtures:      (fixtures:     (fixtures:   (fixtures:
    sample URLs) capture        registry rows) mock API)    recorded
                 bundles)                                    page sessions)

Phase 2 (integration):
   wire queue (BullMQ) between monitor↔generator; wire web/extension → real API;
   run 03-data-flow end-to-end on 3 real sites.
```

**Critical seam corrections vs. the source diagram** (do not copy the diagram literally):

1. **Self-healer is Node + Claude**, implemented in `services/generator`, *not* in the Go monitor.
   The Go monitor only *detects* drift and *enqueues* a job. See `services/generator.md` §Self-healer.
2. **The extension is three separable things** — popup (funnel), side panel (the product),
   net-intercept (a generation data source). Net-intercept's output is a **capture bundle** (a `01`
   contract), identical in shape to the scraper's output.
3. **Legal enforcement lives in two runtimes** — scraper (robots.txt/ToS) and extension
   (session/credentials). `04-legal-modes.md` is the single policy source both link to.

## Open questions
- Turborepo vs. Nx vs. pnpm workspaces only — verify Turborepo remote-cache fit for mixed Python/Go.
- How are Python/Go contract mirrors kept in sync — codegen from a JSON Schema, or hand-maintained? (see `01`).
