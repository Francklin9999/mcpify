// Full local e2e with NO external network: a mock website + a mock OpenAI-compatible endpoint, both in-process.
// Exercises the paths the other tests miss: NodeStaticScraper.capture() (real fetch), forge_scrape,
// forge_generate (default heuristic), and OpenAICompatibleInferenceClient (real call + response parse).
// Run: node test/local-e2e.mjs
import http from "node:http";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/src/server.js";

const listen = (srv) => new Promise((res, rej) => {
  srv.once("error", rej);
  srv.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${srv.address().port}`));
});

// --- mock website ---
const siteHtml = `<!doctype html><html><head><title>Mock Shop</title></head><body>
<h1>Products</h1>
<form action="/search" method="get"><input name="q" placeholder="search"><button>Search</button></form>
<a href="/products/1">Product 1</a><a href="/about">About</a>
</body></html>`;
const site = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(siteHtml); });

// --- mock OpenAI-compatible endpoint: returns a canned tool so we can prove the client actually called it ---
const cannedToolName = "search_products_via_mock";
const cannedTool = {
  name: cannedToolName,
  description: "Search products (from the mock model).",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern: "/search", rawUrl: "http://127.0.0.1/search", requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" },
    paramMapping: {},
  },
  confidence: 0.8,
};
let openaiCalled = false;
const openai = http.createServer((req, res) => {
  openaiCalled = true;
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tools: [cannedTool] }) } }] }));
  });
});

let siteUrl;
let openaiBase;
try {
  siteUrl = await listen(site);
  openaiBase = (await listen(openai)) + "/v1";
} catch (err) {
  if (err?.code === "EPERM") {
    console.log("SKIP: local-e2e requires binding 127.0.0.1, which this sandbox blocks.");
    site.close(); openai.close();
    process.exit(0);
  }
  throw err;
}

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };

async function withServer(env, fn) {
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
  };
  try {
    await fn(call);
  } finally {
    await client.close();
    await server.close();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

try {
  // --- default mode: heuristic, no key. Exercises NodeStaticScraper.capture + analyze + heuristic + codegen. ---
  const home1 = join(tmpdir(), "forge-e2e-heuristic"); rmSync(home1, { recursive: true, force: true });
  // Pin the in-process managed scraper: FORGE_USE_REAL_BROWSER=0 keeps the deterministic pipeline from auto-opening
  // the user's real Chrome on a desktop, and FORGE_CRAWL=0 asserts single-page capture (no base-domain exploration).
  await withServer({ URLMCP_HOME: home1, FORGE_ALLOW_PRIVATE_HOSTS: "1", FORGE_AUTH_HANDOFF: "0", FORGE_USE_REAL_BROWSER: "0", FORGE_CRAWL: "0" }, async (call) => {
    const scrape = await call("forge_scrape", { url: siteUrl });
    if (scrape.isError) bad("forge_scrape returns analysis", scrape.text);
    else if (!scrape.text.includes("PAGE ANALYSIS")) bad("forge_scrape returns analysis", "no analysis section");
    else ok("forge_scrape: NodeStaticScraper.capture + analyze worked (real fetch)");

    const gen = await call("forge_generate", { url: siteUrl });
    const wrote = existsSync(join(home1, "registry.json"));
    if (gen.isError) bad("forge_generate (heuristic) builds a server", gen.text);
    else if (!wrote) bad("forge_generate (heuristic) builds a server", "no registry.json written");
    else ok("forge_generate (heuristic): capture -> infer -> codegen -> persist worked, no key");
  });
  rmSync(home1, { recursive: true, force: true });

  // --- openai-compatible against the mock: proves OpenAICompatibleInferenceClient actually CALLS and parses. ---
  const home2 = join(tmpdir(), "forge-e2e-openai"); rmSync(home2, { recursive: true, force: true });
  await withServer(
    { URLMCP_HOME: home2, FORGE_ALLOW_PRIVATE_HOSTS: "1", FORGE_AUTH_HANDOFF: "0", FORGE_USE_REAL_BROWSER: "0", FORGE_CRAWL: "0", FORGE_INFERENCE: "openai-compatible", FORGE_OPENAI_BASE_URL: openaiBase, FORGE_API_KEY: "test", FORGE_MODEL: "mock-model" },
    async (call) => {
      const gen = await call("forge_generate", { url: siteUrl });
      if (gen.isError) bad("forge_generate (openai-compatible) builds a server", gen.text);
      else if (!openaiCalled) bad("OpenAI-compatible client actually called the endpoint", "endpoint never hit");
      else if (!gen.text.includes(cannedToolName)) bad("mock model's tool flowed through", `canned tool not in output:\n${gen.text}`);
      else ok("forge_generate (openai-compatible): real call to /v1/chat/completions + parse + codegen worked");
    },
  );
  rmSync(home2, { recursive: true, force: true });
} catch (err) {
  bad("e2e harness", err.message);
}

site.close(); openai.close();
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log("\nPASS: full local pipeline (capture -> analyze -> infer[heuristic & openai-compatible] -> codegen -> persist) works with no external network.");
