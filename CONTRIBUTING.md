# Contributing to MCP Forge

Thanks for your interest in contributing! This is a monorepo with three products sharing one core. This guide
gets you productive fast and keeps the bar high.

## Repo layout

See the [monorepo layout](./README.md#monorepo-layout) in the README. The short version:

- `packages/*` — shared contracts (`@mcp/types`) and DB (`@mcp/db`).
- `services/*` — generator (Node), scraper (Python), monitor (Go), and the two MCP servers (`mcp-forge`
  standalone + `mcp-forge-remote` thin client).
- `apps/*` — the Next.js web app and the static MV3 Chrome extension.

## Prerequisites

- **Node.js >= 20** (npm workspaces)
- Python 3.11+ (only for `services/scraper`)
- Go 1.22+ (only for `services/monitor`)
- Docker (only for the full backend stack)

## Getting started

```bash
git clone https://github.com/FranckFongang/mcp-forge.git
cd mcp-forge
npm install
npm run build            # build all workspaces
npm test                 # run the Node test suites
```

To work on just the standalone MCP server:

```bash
npm run build --workspace=mcp-forge
npm test  --workspace=mcp-forge   # provider resolution + stdio boot + e2e (no key, no network)
```

## Development workflow

1. **Branch** off `main`: `git checkout -b feat/short-description`.
2. **Make focused changes.** Match the surrounding code's style, naming, and comment density.
3. **Keep contracts in `@mcp/types`.** Cross-component shapes have exactly one source of truth there. Changing
   an `execution_kind` or a DB-backed enum requires a migration — see `packages/db`.
4. **Test what you change.** Prefer real-infra/honest tests that *skip loudly* when a dependency (browser,
   Docker, Postgres) is unavailable rather than faking success.
5. **Add a changeset** (see below) if your change affects a published package.
6. **Open a PR** using the template. CI must be green.

## Tests

```bash
npm test                                          # all Node unit suites
npm test --workspace=mcp-forge                    # standalone MCP server
cd services/scraper && .venv/bin/python -m pytest # scraper (Chromium tier skips if unavailable)
cd services/monitor && go test ./internal/...     # monitor logic
```

## Changesets & releases

We use [Changesets](https://github.com/changesets/changesets). If your change should ship in a published
package (currently `mcp-forge`), run:

```bash
npx changeset
```

Pick the affected package(s) and a bump (patch / minor / major), and write a short, user-facing summary. Commit
the generated file in `.changeset/`. On merge to `main`, the release workflow opens/updates a "Version Packages"
PR; merging that publishes to npm (with provenance, via trusted publishing).

## Commit & PR conventions

- Clear, imperative commit subjects (`fix: handle empty tool list`).
- One logical change per PR where possible.
- Update docs (`README.md`, package READMEs) alongside behavior changes.
- Do **not** commit secrets, `.env` files, or generated artifacts (see `.gitignore`).

## Code style

- TypeScript: `strict` mode, `noUncheckedIndexedAccess`. No `any` where a real type fits.
- Fail-closed at trust boundaries; validate external/wire data through the zod contracts.
- Comments explain *why*, not *what*.

## Reporting bugs / requesting features

Use the [issue templates](https://github.com/FranckFongang/mcp-forge/issues/new/choose). For security issues,
**do not** open a public issue — see [SECURITY.md](./SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
