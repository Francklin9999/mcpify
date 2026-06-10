// End-to-end (no key, no network): call forge_emit_server through the real MCP protocol with a hand-crafted
// tool, and verify it writes a runnable server to disk. Run: node test/emit.mjs
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/src/server.js";

const HOME = join(tmpdir(), "forge-emit-test");
rmSync(HOME, { recursive: true, force: true });

const tool = {
  name: "fetch_page",
  description: "Fetch the homepage HTML.",
  inputSchema: { type: "object", properties: {} },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern: "/", rawUrl: "https://example.com", requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" },
    paramMapping: {},
  },
  confidence: 0.7,
};

try {
  const oldHome = process.env.MCP_FORGE_HOME;
  const oldAllowPrivate = process.env.FORGE_ALLOW_PRIVATE_HOSTS;
  process.env.MCP_FORGE_HOME = HOME;
  process.env.FORGE_ALLOW_PRIVATE_HOSTS = "1";
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "emit", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const res = await client.callTool({ name: "forge_emit_server", arguments: { url: "https://example.com", title: "Example", tools: [tool] } });
  const out = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`tool returned error: ${out}`);
  await client.close();
  await server.close();
  if (oldHome === undefined) delete process.env.MCP_FORGE_HOME;
  else process.env.MCP_FORGE_HOME = oldHome;
  if (oldAllowPrivate === undefined) delete process.env.FORGE_ALLOW_PRIVATE_HOSTS;
  else process.env.FORGE_ALLOW_PRIVATE_HOSTS = oldAllowPrivate;

  const dir = join(HOME, "servers", "example-com-v1");
  const wroteServer = existsSync(join(dir, "src", "server.ts")) || existsSync(join(dir, "server.ts"));
  const wrotePkg = existsSync(join(dir, "package.json"));
  const wroteRegistry = existsSync(join(HOME, "registry.json"));
  if (!existsSync(dir)) throw new Error(`server dir not created: ${dir}`);
  if (!wrotePkg) throw new Error("package.json not written");
  if (!wroteServer) throw new Error("server source not written");
  if (!wroteRegistry) throw new Error("registry.json not written");

  console.log(`PASS: forge_emit_server wrote a runnable server to ${dir} (package.json+server+registry). No key, no network.`);
  rmSync(HOME, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}
