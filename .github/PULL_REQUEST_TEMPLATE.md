<!-- Thanks for contributing to MCP Forge! Please fill this out. -->

## What & why

<!-- What does this PR change, and why? Link any related issue: Closes #123 -->

## Component(s)

- [ ] Standalone MCP server (`mcp-forge`)
- [ ] Web app + backend (generator / scraper / monitor / web)
- [ ] Chrome extension
- [ ] Shared packages (`@mcp/types`, `@mcp/db`)
- [ ] CI / tooling / docs

## How was it tested?

<!-- Commands you ran and what you observed. Honest tests that skip-loudly are preferred over faked passes. -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` (and `npm test --workspace=mcp-forge` if it applies) passes
- [ ] Cross-component shapes stay in `@mcp/types` (DB-enum changes include a migration)
- [ ] Docs updated (README / package README) if behavior changed
- [ ] Added a changeset (`npx changeset`) if a published package changed
- [ ] No secrets, `.env`, or generated artifacts committed
