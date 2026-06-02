import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ForgeClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Stdio entry point for the MCP Forge meta-server. An MCP client (Claude, Codex, Cursor, ...) launches this
 * over stdio; it talks to a running MCP Forge instance over HTTP.
 *   MCP_FORGE_API_BASE  - the Forge web API base (default http://localhost:3001)
 */
async function main(): Promise<void> {
  const base = process.env.MCP_FORGE_API_BASE?.trim() || "http://localhost:3001";
  const client = new ForgeClient({ base });
  const server = createServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp-forge] fatal:", err);
  process.exit(1);
});
