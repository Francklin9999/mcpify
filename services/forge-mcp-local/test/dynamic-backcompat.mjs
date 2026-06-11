// Backward-compatibility guard for the DYNAMIC-website pipeline (hermetic — no browser, no network).
//
// The standalone server's headline capability is: render a dynamic site, capture its XHR/fetch traffic, and
// turn that captured traffic into callable tools. This test pins that behavior against REAL captured-dynamic-site
// fixtures so a future refactor can't silently stop generating tools for SPAs / AJAX sites. It also round-trips
// the exact CaptureBundle shape the in-process browser scraper emits through the frozen @mcp/types contract.
//
// Run: node test/dynamic-backcompat.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inferTools, HeuristicInferenceClient } from "@mcp/generator/lean";
import { CaptureBundle } from "@mcp/types";

const fixture = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url)), "utf8"));

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

// Build a tier-2 (browser-rendered) CaptureBundle around a captured-traffic fixture, exactly as the in-process
// stealth scraper produces: renderedWithJs=true, tier=2, source="scraper", network = the captured XHR/fetch.
function dynamicBundle(url, network, html = "<html><body>app</body></html>") {
  return {
    bundleId: "22222222-2222-4222-8222-222222222222",
    source: "scraper",
    url,
    capturedAt: "2026-06-10T00:00:00.000Z",
    legalMode: "safe",
    tier: 2,
    dom: { html, domHash: "sha256:x" },
    network,
    meta: { title: "Dynamic site", robotsAllowed: true, renderedWithJs: true },
  };
}
const httpTools = (tools) => tools.filter((t) => t.execution.kind === "http");
const hostOf = (t) => { try { return new URL(t.execution.request.rawUrl).hostname; } catch { return ""; } };

// 1) Real AJAX site (scrapethissite.com/pages/ajax-javascript): one same-site JSON endpoint buried in 5 trackers
//    + a stylesheet. The dynamic pipeline must surface the real endpoint and drop the noise.
await check("AJAX site: captured same-site XHR becomes an http tool, trackers/assets dropped", async () => {
  const bundle = CaptureBundle.parse(dynamicBundle("https://www.scrapethissite.com/pages/ajax-javascript/", fixture("real-world-html/tier2-ajax-network.json")));
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const tools = httpTools(result.tools);
  const ajax = tools.find((t) => /ajax-javascript/.test(t.execution.request.urlPattern));
  assert.ok(ajax, "the real same-site AJAX endpoint became a tool");
  assert.equal(ajax.execution.request.method, "GET");
  const hosts = tools.map(hostOf);
  assert.ok(!hosts.some((h) => /google-analytics\.com|^www\.google\.com$|facebook\.com/.test(h)), "analytics/ad/pixel trackers must be dropped");
  assert.ok(!tools.some((t) => /\.css\b/.test(t.execution.request.urlPattern)), "static assets (bootstrap.min.css) must be dropped");
});

// 2) Real React SPA (Algolia-backed search): the search XHR is a POST with a JSON body. The dynamic pipeline must
//    turn it into a search tool whose query lives in the request body — the SPA-search superpower.
await check("React SPA: captured search XHR becomes a POST tool with body params", async () => {
  const bundle = CaptureBundle.parse(dynamicBundle("https://uj5wyc0l7x-dsn.algolia.net/", fixture("real-world-html/tier2-react-spa-network.json")));
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const search = httpTools(result.tools).find((t) => /\/1\/indexes\/.+\/query/.test(t.execution.request.urlPattern));
  assert.ok(search, "the SPA's search/query XHR became a tool");
  assert.equal(search.execution.request.method, "POST");
  assert.equal(search.execution.paramMapping.query?.in, "body", "the search query maps to the request body");
  assert.ok(!result.tools.some((t) => /isalive|collect/.test(t.name)), "health-check + analytics endpoints must be dropped");
});

// 3) Contract round-trip: the EXACT shape the in-process browser scraper emits must keep parsing against the
//    frozen @mcp/types contract (tier 4-capable union, renderedWithJs, templated network paths). This is the
//    backward-compat tripwire for the capture contract itself.
await check("CaptureBundle contract still accepts the browser scraper's tier-2 dynamic output", async () => {
  const emitted = dynamicBundle("https://example.com/app", [
    { method: "GET", urlPattern: "/api/items/{id}", rawUrl: "https://example.com/api/items/7?q=shoes", requestHeaders: { accept: "application/json" }, responseSchema: { type: "object" }, statusCode: 200, contentType: "application/json" },
  ]);
  const parsed = CaptureBundle.parse(emitted);
  assert.equal(parsed.tier, 2);
  assert.equal(parsed.meta.renderedWithJs, true);
  assert.equal(parsed.network[0].urlPattern, "/api/items/{id}", "templated network path preserved");
});

console.log(failed === 0 ? "\nPASS: dynamic-website pipeline (captured XHR -> tools) + capture contract are backward-compatible." : `\nFAIL: ${failed} check(s).`);
process.exit(failed === 0 ? 0 : 1);
