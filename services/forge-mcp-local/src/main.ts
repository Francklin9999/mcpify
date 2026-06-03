#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Stdio entry point for the SELF-CONTAINED MCP Forge server. Unlike services/forge-mcp (a thin client to the
 * hosted web API), this runs the whole generate pipeline IN-PROCESS - scrape -> (host model or a configured
 * provider) -> codegen -> write files - with no backend, no Postgres, no Redis.
 *
 * An MCP client (Claude Code / Codex / Cursor / ...) launches it over stdio. By default it needs NO API key:
 * use forge_scrape + forge_emit_server and let the calling model design the tools. See README for the
 * FORGE_INFERENCE options (OpenAI/Anthropic/Gemini/Groq/Ollama/.../custom URL) if you want server-side inference.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  setInterval(() => undefined, 2_147_483_647);
}

main().catch((err) => {
  console.error("[mcp-forge] fatal:", err);
  process.exit(1);
});
