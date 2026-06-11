// Honest smoke test: boot the built server with ZERO config (no API key, no backend) and confirm the MCP
// handshake works and the three tools are registered. Run: node test/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/src/server.js";

const server = createServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke", version: "0.0.0" });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const list = await client.listTools();
  const names = (list.tools ?? []).map((t) => t.name).sort();
  const expected = ["forge_emit_server", "forge_generate", "forge_scrape"];
  const ok = expected.every((n) => names.includes(n));
  if (!ok) throw new Error(`missing tools. got: ${names.join(", ")}`);

  console.log(`PASS: urlmcp booted; tools = [${names.join(", ")}]`);
  await client.close();
  await server.close();
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  process.exit(1);
}
