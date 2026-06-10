// Security regression tests for the codegen RCE fix + URL-validation boundary. Run: node test/security.mjs
//  (1) codegen layer: a url/title carrying JS line terminators must NOT inject top-level code into the
//      generated server.ts (commentSafe must strip them). This is the Critical RCE found in review.
//  (2) boundary layer: forge_scrape must reject a URL containing control chars / line breaks / bad scheme.
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateServerSource } from "@mcp/generator/lean";
import { createServer } from "../dist/src/server.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };

// ---- (1) codegen RCE regression ----
const validTool = {
  name: "fetch_page",
  description: "Fetch the homepage.",
  inputSchema: { type: "object", properties: {} },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern: "/", rawUrl: "https://example.com", requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" },
    paramMapping: {},
  },
  confidence: 0.7,
};

for (const term of ["\n", "\r", " ", " "]) {
  const evil = `https://x/${term}import cp from "node:child_process";cp.execSync("touch /tmp/PWNED");${term}//`;
  const src = generateServerSource({
    serverId: "00000000-0000-4000-8000-000000000000",
    version: 1,
    url: evil,
    title: `Title${term}cp.execSync("nope")`,
    tools: [validTool],
    browsing: false,
  });
  const label = term === "\n" ? "LF" : term === "\r" ? "CR" : term === " " ? "U+2028" : "U+2029";
  // The injected payload must never appear as a top-level statement (it may appear inside the // header
  // comment as inert text, or inside the JSON.stringify'd SITE_URL string literal — both are safe).
  try {
    assert.ok(!/^\s*import cp\b/m.test(src), "injected import reached top level");
    assert.ok(!/^\s*cp\.execSync/m.test(src), "injected call reached top level");
    assert.ok(src.split("\n")[0].startsWith("// AUTO-GENERATED MCP server for"), "header line malformed");
    ok(`codegen neutralizes ${label} line-terminator injection in url/title`);
  } catch (e) {
    bad(`codegen neutralizes ${label} injection`, e.message);
  }
}

// ---- (2) boundary: forge_scrape rejects a control-char URL / bad scheme ----
function rpcOnce(args) {
  return (async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sec", version: "0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const r = await client.callTool({ name: "forge_scrape", arguments: args });
      return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
    } catch (e) {
      return { text: String(e), isError: true };
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  })();
}

try {
  const res = await rpcOnce({ url: 'https://example.com/\nimport cp from "node:child_process"' });
  if (res.isError && /control character|line break/i.test(res.text)) ok("forge_scrape rejects a control-char URL at the boundary");
  else bad("forge_scrape rejects control-char URL", `got isError=${res.isError} text=${res.text.slice(0, 120)}`);

  const res2 = await rpcOnce({ url: "file:///etc/passwd" });
  if (res2.isError && /scheme/i.test(res2.text)) ok("forge_scrape rejects non-http(s) scheme (file://)");
  else bad("forge_scrape rejects file:// scheme", `got isError=${res2.isError} text=${res2.text.slice(0, 120)}`);

  const res3 = await rpcOnce({ url: "http://127.0.0.1:12345/" });
  if (res3.isError && /private|loopback|non-public|reserved/i.test(res3.text)) ok("forge_scrape rejects loopback/private targets by default");
  else bad("forge_scrape rejects loopback target", `got isError=${res3.isError} text=${res3.text.slice(0, 160)}`);
} catch (e) {
  bad("boundary checks", e.message);
}

if (failed) { console.error(`\n${failed} security check(s) FAILED`); process.exit(1); }
console.log("\nPASS: RCE codegen sanitization + URL-validation boundary hold.");
