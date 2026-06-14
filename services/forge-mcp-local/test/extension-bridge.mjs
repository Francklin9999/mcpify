// Hermetic test for the Chrome-extension backend, with NO Chrome: a fake "extension" (plain fetch) drives the
// loopback bridge, and we assert the full round-trip — command dispatch, result return, the extension->RawCall
// transform (JSON schema inference + secret scrubbing + URL templating), bundle assembly, the ExtensionScraper
// happy path AND its degrade-to-fallback when no extension is connected, plus the capture timeout.
// Run: node test/extension-bridge.mjs
import assert from "node:assert";

// Pin the bridge port + a short connect wait BEFORE importing the modules that read them at load time.
const PORT = 47931;
process.env.FORGE_EXT_PORT = String(PORT);
process.env.FORGE_EXT_WAIT_MS = "300";

const { getSharedBridge } = await import("../dist/src/extension-bridge.js");
const { ExtensionScraper } = await import("../dist/src/extension-scraper.js");
const { assembleBundle } = await import("../dist/src/playwright-scraper.js");

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.stack ?? e?.message ?? e); } }

const BASE = `http://127.0.0.1:${PORT}/urlmcp`;
const getJson = async (path) => (await fetch(BASE + path)).json();
const postResult = (payload) => fetch(BASE + "/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

// A fake extension: announce, poll until a command arrives, hand it to `makeResult`, post the result back.
async function fakeExtensionOnce(makeResult) {
  await getJson("/hello");
  let cmd;
  for (let i = 0; i < 50; i++) {
    const c = await getJson("/next");
    if (c && c.id) { cmd = c; break; }
  }
  assert.ok(cmd, "fake extension received a command");
  await postResult(makeResult(cmd));
  return cmd;
}

let bridge;
try {
  bridge = await getSharedBridge();
} catch (e) {
  if (e?.code === "EPERM" || e?.code === "EACCES") {
    console.log("  SKIP: extension bridge loopback listen is blocked in this sandbox.");
    process.exit(0);
  }
  throw e;
}

// A sentinel fallback scraper so we can prove ExtensionScraper degrades to it when nothing is connected.
const fallback = {
  async capture(url, legalMode) {
    return assembleBundle({ url, legalMode, tier: 2, html: "<html><head><title>FALLBACK</title></head><body>x</body></html>", raw: [] });
  },
};

await check("not connected before any extension polls", () => {
  assert.strictEqual(bridge.isConnected(), false);
});

await check("ExtensionScraper degrades to the fallback when no extension is connected", async () => {
  const scraper = new ExtensionScraper(fallback);
  const bundle = await scraper.capture("https://example.com/", "safe");
  assert.strictEqual(bundle.meta.title, "FALLBACK", "fell back to the managed scraper");
});

await check("end-to-end: ExtensionScraper capture round-trips through the bridge into a CaptureBundle", async () => {
  const scraper = new ExtensionScraper(fallback);
  const result = (cmd) => ({
    id: cmd.id,
    ok: true,
    url: cmd.url,
    title: "Feed",
    html: "<html><head><title>Feed</title></head><body>hello world</body></html>",
    network: [
      {
        method: "POST",
        url: "https://example.com/api/users/123456/graphql",
        requestHeaders: { "content-type": "application/json", authorization: "Bearer zzz" },
        reqContentType: "application/json",
        requestPostData: JSON.stringify({ query: "feed", password: "hunter2" }),
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({ items: [1, 2, 3], next: "abc" }),
      },
    ],
  });
  const [bundle] = await Promise.all([scraper.capture("https://example.com/feed", "safe"), fakeExtensionOnce(result)]);

  assert.strictEqual(bundle.tier, 4, "extension capture is tier 4 (real browser/session)");
  assert.strictEqual(bundle.meta.title, "Feed");
  assert.ok(bundle.dom.html.includes("hello world"), "DOM carried through");
  assert.strictEqual(bundle.network.length, 1, "one captured call");

  const call = bundle.network[0];
  assert.strictEqual(call.method, "POST");
  assert.strictEqual(call.urlPattern, "/api/users/{id}/graphql", "id segment templated");
  assert.ok(call.responseSchema, "response schema inferred");
  assert.deepStrictEqual(call.responseSchema.properties.items, { type: "array" }, "array field typed");
  // The replay body OMITS secret fields entirely (no "__redacted__" placeholder, which would corrupt a replayed
  // structured body); the non-secret field is preserved so the API still replays.
  assert.ok(call.requestBody && !call.requestBody.includes("hunter2"), "raw secret not present");
  assert.ok(!call.requestBody.includes("password"), "secret field omitted from the replay body");
  assert.ok(!call.requestBody.includes("__redacted__"), "no corrupting placeholder in the replay body");
  assert.ok(JSON.parse(call.requestBody).query === "feed", "non-secret field preserved for replay");
  assert.ok(!("authorization" in call.requestHeaders), "auth header scrubbed");
});

await check("connected after the extension has polled", () => {
  assert.strictEqual(bridge.isConnected(), true);
  // waitForExtension resolves true immediately once connected.
  return bridge.waitForExtension(0).then((c) => assert.strictEqual(c, true));
});

await check("bridge.capture rejects on timeout when the extension never answers", async () => {
  await assert.rejects(
    bridge.capture("https://example.com/never", { settleMs: 5, navTimeoutMs: 50, interact: false, timeoutMs: 200 }),
    /timed out/i,
  );
});

await bridge.close();

console.log(failed ? `\nextension-bridge: ${failed} FAILED` : "\nextension-bridge: all passed");
process.exit(failed ? 1 : 0);
