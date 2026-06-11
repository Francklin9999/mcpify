# Contributing to anymcp

Thanks for your interest! `anymcp` is a single published package built from a small npm workspace. This guide
gets you productive fast and keeps the bar high.

## Repo layout

See the [repository layout](./README.md#repository-layout) in the README. The short version:

- `services/forge-mcp-local/` — the published `anymcp` server (stdio MCP, the three tools, in-process scraper).
- `services/generator/` — the core pipeline: scrape analysis + tool inference + deterministic codegen.
- `packages/types/` — shared zod contracts (`@mcp/types`), the single source of truth for cross-module shapes.

## Prerequisites

- **Node.js >= 20** (npm workspaces).

## Getting started

```bash
git clone https://github.com/Francklin9999/mcpify.git
cd mcpify
npm install
npm run build            # build generator + types, bundle the server
npm test                 # run the server test suites (no key, no network)
```

To iterate on just the server package:

```bash
npm run bundle --workspace=anymcp
npm test    --workspace=anymcp
```

## Development workflow

1. **Branch** off `main`: `git checkout -b feat/short-description`.
2. **Make focused changes.** Match the surrounding code's style, naming, and comment density.
3. **Keep contracts in `@mcp/types`.** Cross-module shapes have exactly one source of truth there. The execution
   contract (`ExecutionStrategy = http | browser`) is frozen — new capabilities go in the runtime layer or as
   new discovery sources, never as contract changes.
4. **Test what you change.** Prefer honest tests that *skip loudly* when a dependency (e.g. a browser) is
   unavailable rather than faking success.
5. **Open a PR** using the template. CI must be green.

## Tests

```bash
npm test                            # the server's suites: provider resolution, stdio boot, emit e2e, full local pipeline
npm run test:all                    # every workspace's tests
```

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

Use the [issue templates](https://github.com/Francklin9999/mcpify/issues/new/choose). For security issues,
**do not** open a public issue — see [SECURITY.md](./SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
