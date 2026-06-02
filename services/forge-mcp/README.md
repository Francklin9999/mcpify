# MCP Forge — the meta-MCP (an MCP that creates MCPs)

A thin MCP server that puts **MCP Forge itself behind MCP tools**, so any agent (Claude, Codex, Cursor, …)
can turn a website into a brand-new MCP server on demand — then browse, inspect, and download everything
Forge has already generated.

It's a *layer on top* of the existing Forge web API: this server holds no state and runs no pipeline. It
just calls a running MCP Forge instance over HTTP.

## Tools

| Tool | What it does |
|------|--------------|
| `forge_mcp_server({ url, legalMode?, wait? })` | Generate a new MCP server from a website. Waits briefly (~30s) then returns the new server's tools + a download URL, or a `jobId` to poll. |
| `forge_job_status({ jobId })` | Get a forge job's result (finished server) or status. |
| `search_mcp_catalog({ q?, tier? })` | Search servers Forge has already generated. |
| `get_mcp_server({ serverId })` | Tools, versions, confidence, download URL for one server. |
| `download_mcp_server({ serverId, version? })` | The download URL + summary for a server's runnable artifact. |
| `install_mcp_server({ serverId, version?, dir? })` | Write the server's runnable files (incl. `install.sh`/`install.ps1`/`mcp-register.mjs`) to a local dir, **ready to install**, and return the one command to finish. |

Generation (scrape + LLM + codegen) can take minutes, so `forge_mcp_server` never blocks open-ended: it
returns a `jobId` you poll with `forge_job_status`. If a job stays `queued`, the Forge **generator worker**
probably isn't running.

## Configure

- `MCP_FORGE_API_BASE` — the Forge web API base. Default `http://localhost:3001`. Point it at your deployed
  Forge to forge servers against the hosted instance.

The target Forge must be fully up (web API + generator worker + Redis + Postgres + scraper) for
`forge_mcp_server` to complete; the read tools (`search_mcp_catalog`, `get_mcp_server`) only need the web API.

## Install into your MCP client

```bash
npm install && npm run build   # produces dist/src/main.js
```

Then register it like any stdio MCP server (absolute path to `dist/src/main.js`):

```bash
# Claude Code
claude mcp add mcp-forge -s user --env MCP_FORGE_API_BASE=http://localhost:3001 -- node /abs/path/to/services/forge-mcp/dist/src/main.js

# Codex
codex mcp add mcp-forge --env MCP_FORGE_API_BASE=http://localhost:3001 -- node /abs/path/to/services/forge-mcp/dist/src/main.js
```

For Claude Desktop / Cursor / Windsurf, add the equivalent `mcpServers` entry pointing `command: "node"`,
`args: ["/abs/path/to/services/forge-mcp/dist/src/main.js"]`, with `env.MCP_FORGE_API_BASE` set.

## The recursion

The servers this forges ship their own one-step installer that registers into every detected MCP client. So:

1. `forge_mcp_server("https://rubygems.org")` → a new MCP server (tools + serverId).
2. `install_mcp_server({ serverId })` → writes its files to `~/.mcp-forge/servers/<id>-v<n>/`, ready to install.
3. Run the returned command (`bash install.sh`) → it builds and registers the new server into Claude / Codex /
   Cursor / Windsurf / VS Code (the multi-client installer baked into the artifact).
4. Restart the client → **new tools available.**

MCP Forge, all the way down. `install_mcp_server` writes files only and never runs the installer for you
(it builds with npm and edits client configs); it contains every write under the target dir, so a malformed
artifact path can't escape it.
