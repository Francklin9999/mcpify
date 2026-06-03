# Security Policy

## Supported versions

MCP Forge is pre-1.0 and under active development. Security fixes target the latest `main` and the most recent
published release of `mcp-forge` on npm.

| Version | Supported |
|---------|-----------|
| latest `main` / latest npm release | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use **[GitHub Security Advisories](https://github.com/Francklin9999/mcpify/security/advisories/new)**
to report privately. Include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- Affected component (standalone `mcp-forge`, web/backend, extension) and version/commit.

You can expect an initial acknowledgement within a few days. We'll keep you informed as we investigate and
coordinate a fix and disclosure.

## Scope & threat model notes

MCP Forge generates and runs code that automates websites **on the user's machine, with the user's
credentials**. Some important boundaries:

- **Generated servers run locally.** They are not a hosted scraping service. Treat generated `server.ts` as
  code you are about to run — review it like any dependency.
- **Credentials never go server-side.** The extension acts inside your own browser session; the standalone
  MCP and generated servers use your local environment.
- **Path containment.** Artifact writers reject absolute paths and `..` traversal when materializing generated
  files. If you find a way to escape the target directory, that's a vulnerability — please report it.
- **Inference endpoints.** When you configure a provider key or a custom inference URL, that data leaves your
  machine to the endpoint you chose. The default (host-as-brain / heuristic) makes no external inference calls.

## Good-faith research

We support responsible security research. We will not pursue or support legal action against researchers who
act in good faith, avoid privacy violations and service disruption, and give us reasonable time to remediate
before public disclosure.
