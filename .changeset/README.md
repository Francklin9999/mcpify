# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets) — it's how we version and
publish the public packages in this monorepo (currently `mcp-forge`).

When you make a change that should ship in a published package, run:

```bash
npx changeset
```

Select the affected package(s), choose a bump (patch / minor / major), and write a short, user-facing summary.
Commit the generated Markdown file here. On merge to `main`, CI opens/updates a "Version Packages" PR that
aggregates pending changesets into version bumps + changelog entries; merging that PR publishes to npm.

Private packages (`@mcp/*`, the web app, the extension) are not published, so they don't need changesets.
