import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "mcp.config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const local = config.local ?? {};

const protocol = process.env.MCP_WEB_PROTOCOL || local.webProtocol || "http";
const host = process.env.MCP_WEB_HOST || local.webHost || "localhost";
const port = process.env.WEB_PORT || process.env.MCP_WEB_PORT || local.webPort;
const defaultApiBase = process.env.MCP_API_BASE || `${protocol}://${host}${port ? `:${port}` : ""}`;

if (!/^https?:\/\/[^/]+/i.test(defaultApiBase)) {
  throw new Error(`Invalid MCP_API_BASE: ${defaultApiBase}`);
}

const js = `// Generated from mcp.config.json by scripts/sync-extension-config.mjs.
// The extension is static MV3, so it needs this small checked-in mirror of the root local default.
export const DEFAULT_API_BASE = ${JSON.stringify(defaultApiBase)};
`;

const ts = `// Generated from mcp.config.json by scripts/sync-extension-config.mjs.
// The extension is static MV3, so it needs this small checked-in mirror of the root local default.
export const DEFAULT_API_BASE = ${JSON.stringify(defaultApiBase)};
`;

const libDir = resolve(root, "apps/extension/lib");
await mkdir(libDir, { recursive: true });
await Promise.all([
  writeFile(resolve(libDir, "config.js"), js),
  writeFile(resolve(libDir, "config.ts"), ts),
]);

console.log(`Synced extension DEFAULT_API_BASE=${defaultApiBase}`);
