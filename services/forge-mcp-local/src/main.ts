#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { installExtension } from "./extension-assets.js";

/**
 * Stdio entry point for the self-contained urlmcp server: runs the whole generate pipeline in-process
 * (scrape -> inference -> codegen -> write files) with no backend. Needs no API key by default (forge_scrape +
 * forge_emit_server let the calling model design the tools); see README for FORGE_INFERENCE options.
 *
 * Also a tiny CLI: `urlmcp install-extension` materializes the Chrome connector extension (drive the user's real
 * signed-in browser) and prints how to load it; everything else starts the MCP stdio server.
 */
function runInstallExtension(): void {
  const port = Number(process.env["FORGE_EXT_PORT"]) || 47_900;
  const { dir, files } = installExtension(undefined, port);
  const lines = [
    `Wrote the urlmcp browser connector (${files.length} files) to:`,
    `  ${dir}`,
    ``,
    `Load it into your real Chrome (one-time):`,
    `  1. Open chrome://extensions`,
    `  2. Turn on "Developer mode" (top-right)`,
    `  3. Click "Load unpacked" and select the folder above`,
    `  4. Keep Chrome open.`,
    ``,
    `Then run urlmcp with:  FORGE_BROWSER_BACKEND=extension`,
    `Captures will render in your real, signed-in session (bridge: http://127.0.0.1:${port}).`,
  ];
  // CLI output goes to stdout (this path does not speak MCP).
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  if (process.argv[2] === "install-extension") {
    runInstallExtension();
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  setInterval(() => undefined, 2_147_483_647);
}

main().catch((err) => {
  console.error("[urlmcp] fatal:", err);
  process.exit(1);
});
