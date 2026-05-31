# Project Plan — Auto-Generated MCP Server Platform

**One sentence:** A tool that auto-generates MCP servers from any website, keeps them alive
with continuous re-parsing and self-healing, and serves them through a curated library — with a
Chrome extension that lets an LLM assist you on any page you're already browsing.

This `docs/` folder is the implementation plan. It is decomposed so that **each service/app can be
built independently against fixed contracts and fixtures**, with no live dependency on the others.

## How to read these docs

1. Read `00-overview.md` for the product, the monorepo layout, and the **build-order dependency graph**.
2. Read `01-contracts.md` — the keystone. Every cross-component data shape is defined here once.
   All other docs reference it instead of redefining shapes.
3. Then pick up any single service/app doc and implement it against the contracts + fixtures.

## Document index

| Doc | Scope | Owner runtime |
|-----|-------|---------------|
| [`00-overview.md`](./00-overview.md) | Vision, monorepo layout, build order | — |
| [`01-contracts.md`](./01-contracts.md) | **Keystone.** All shared types & schemas | `packages/types` |
| [`02-data-model.md`](./02-data-model.md) | Postgres / Redis / R2 storage | infra |
| [`03-data-flow.md`](./03-data-flow.md) | End-to-end sequence (URL → live server) | — |
| [`04-legal-modes.md`](./04-legal-modes.md) | Cross-cutting compliance policy & enforcement points | — |
| [`services/scraper.md`](./services/scraper.md) | Scrapling 3-tier fetcher → capture bundle | Python |
| [`services/generator.md`](./services/generator.md) | Tool inference + codegen **+ self-healer** | Node.js |
| [`services/monitor.md`](./services/monitor.md) | Health check + change detection + enqueue | Go |
| [`apps/web.md`](./apps/web.md) | Web app logic: routes, screens, registry/library | Next.js |
| [`apps/web-ui.md`](./apps/web-ui.md) | Web **frontend design spec** — layout, components, confidence visual system | Next.js + shadcn |
| [`apps/extension.md`](./apps/extension.md) | Popup + side panel + net-intercept | TypeScript/Plasmo |

## Per-doc template (every service/app doc follows this)

1. **Purpose** — one paragraph.
2. **Inputs / Outputs** — every shape links to `01-contracts.md`. No shapes defined locally.
3. **Dependencies** — named, with the contract or queue topic that decouples them.
4. **Data touchpoints** — what it reads/writes in Postgres / Redis / R2 (see `02`).
5. **Implementation steps** — ordered.
6. **How to test in isolation** — what to mock/fixture so this builds with zero other services running.
7. **Acceptance criteria** — observable, testable.
8. **Open questions** — including any niche-library API that the implementer must verify.

> ⚠️ **Library-API caveat (applies to every doc).** This plan names libraries by responsibility
> (Scrapling, Camoufox, Plasmo/WXT, `@modelcontextprotocol/sdk`, BullMQ, Drizzle, etc.). Exact method
> signatures are **not** authoritative here — the implementing agent must verify the current API of each
> library before coding against it. Anything written from memory is flagged in that doc's Open Questions.
