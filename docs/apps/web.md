# App - Web (Next.js + shadcn/ui)

## Purpose
The developer entry point and the **registry/library UI**. Paste a URL -> watch generation -> download
server code + config snippet. Browse curated/auto-gen servers with live confidence. It is a thin client
over the Web API (`01 S7`); it never talks to scraper/generator/monitor directly.

## Inputs / Outputs
- Calls the Web API routes in `01 S7` only. All shapes from `01`.
- Hosts the API route handlers themselves (Next.js API routes) - the **single public surface**.

## Dependencies
- **Next.js** - app + API routes. **shadcn/ui** - components. **zod** - validate request bodies.
- **Drizzle/Postgres** (read registry, write install_count/contributions), **Redis** (read `job:{jobId}`),
  **BullMQ** (enqueue `GenerateJob`). **R2** (serve artifact downloads).

## API routes (implements `01 S7` - frozen list)
| Route | Behavior |
|-------|----------|
| `POST /api/generate` | zod-validate `{url, legalMode, bundle?}`; gate `full_scrape` behind acknowledgement (`04`); enqueue `GenerateJob`; return `{jobId}`. If an extension `CaptureBundle` is present, the worker generates from it directly. |
| `GET /api/jobs/:jobId` | read `job:{jobId}` (Redis) -> `{status, result?}` |
| `GET /api/registry` | query `servers` by `tier`/search -> `RegistryEntry[]` |
| `GET /api/servers/:id` | `RegistryEntry` + `versions` |
| `POST /api/servers/:id/contribute` | accept a `CaptureBundle` (extension/community) -> `contributions` (pending) |
| `GET /api/servers/:id/download/:version` | stream artifact from R2 |
| `POST /api/assist` | side-panel LLM transport; keeps Claude key server-side; prompt-cached system+context; streams turn |

## Screens (UI)

> **Frontend design / layout / visual system -> [`web-ui.md`](./web-ui.md).** This section lists the
> screens and their *logic*; the three-column layout, component mapping, and the confidence visual system
> live in the design spec.
1. **Submit / generate.** URL input + legal-mode selector (default `safe`; `full_scrape` shows an
   acknowledgement dialog - `04`). Live job status (poll `GET /api/jobs/:id`). On done: download +
   copy-paste `claude_desktop_config.json` snippet with instructions to run **locally**.
2. **Library.** Three layers (see Registry/Library below): curated, auto-gen, community. Each card shows
   confidence, install count, last-parsed time, status. One-click install instructions.
3. **Server detail.** Tools list, versions, confidence history, "report broken" (creates a contribution / heal hint).

## Registry / Library layer (the hub)
- **Curated registry:** hand-crafted, fully tested (GitHub, Linear, Notion...). One-click install.
  Confidence always >= 0.95 (`01 S5`). `tier='curated'`.
- **Auto-gen registry:** generated + community-verified. Shows confidence, install count, last-parsed
  time. Can **graduate** to curated. `tier='auto_gen'`.
- **Community layer:** users fix broken tools / submit PRs; extension users passively contribute network
  captures (`03` Flow C). Flywheel effect.

## Legal UI enforcement (see `04`)
- Default mode `safe`. `full_scrape` requires an explicit acknowledgement dialog before `POST /api/generate`.
- Web app **cannot** do `session` mode (that's extension-only) - don't offer it here.
- Never collect credentials anywhere in the web UI.

## Data touchpoints
- Reads: `servers`, `server_versions`, `tools`, Redis `job:{jobId}`, R2 artifacts.
- Writes: enqueue `GenerateJob`, `install_count`, `contributions`.

## How to test in isolation
- Mock the API layer (MSW) for component tests; mock Redis/Postgres/BullMQ for route handler tests.
- Assert: `full_scrape` blocked without acknowledgement; job polling renders states; download streams a fixture artifact.
- No live generator/scraper needed - enqueue is asserted on the mock queue.

## Acceptance criteria
- Pasting a URL enqueues a `GenerateJob` and the UI polls to completion against a faked job result.
- Library lists `RegistryEntry[]` with confidence/install/last-parsed; curated filter works.
- `full_scrape` is impossible without the acknowledgement dialog.

## Open questions (verify before coding)
- **shadcn/ui + Next.js** current setup steps - verify.
- Auth model for the web app (anonymous generate vs. accounts for contributions) - decide.
- "Graduate auto_gen -> curated" trigger: manual review, threshold, or both?
