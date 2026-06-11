#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Stdio entry point for the self-contained MCP Forge server: runs the whole generate pipeline in-process
 * (scrape -> inference -> codegen -> write files) with no backend. Needs no API key by default (forge_scrape +
 * forge_emit_server let the calling model design the tools); see README for FORGE_INFERENCE options.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  setInterval(() => undefined, 2_147_483_647);
}

main().catch((err) => {
  console.error("[urlmcp] fatal:", err);
  process.exit(1);
});
