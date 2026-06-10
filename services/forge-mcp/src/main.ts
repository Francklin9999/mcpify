import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ForgeClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Stdio entry point for the MCP Forge meta-server. An MCP client (Claude, Codex, Cursor, ...) launches this
 * over stdio; it talks to a running MCP Forge instance over HTTP.
 *   MCP_FORGE_API_BASE  - the Forge web API base (default http://localhost:3001)
 */
function envInt(key: string, fallback: number, min: number): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}

async function main(): Promise<void> {
  const base = process.env.MCP_FORGE_API_BASE?.trim() || "http://localhost:3001";
  const timeoutMs = envInt("MCP_FORGE_TIMEOUT_MS", 20_000, 1000);
  const client = new ForgeClient({ base, timeoutMs });
  const server = createServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  setInterval(() => undefined, 2_147_483_647);
}

main().catch((err) => {
  console.error("[mcp-forge] fatal:", err);
  process.exit(1);
});
