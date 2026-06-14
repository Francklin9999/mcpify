// Real dynamic-website test: drives the in-process stealth browser against a LOCAL single-page app whose content
// only exists after JS runs + an XHR resolves. This is the deterministic, offline way to test the dynamic path —
// no flaky external site (Amazon/Skyscanner change + block CI), just a hermetic SPA we control.
//
// It proves the three things that make dynamic sites work: (1) JS actually executes, (2) the page's XHR/fetch
// traffic is captured, (3) that captured traffic becomes a callable tool.
//
// Needs a real Chromium (playwright-core ships none; it downloads on first use). To keep `npm test` fast and
// offline-safe this self-SKIPS unless FORGE_TEST_LIVE_BROWSER=1. Run it explicitly with:
//   FORGE_TEST_LIVE_BROWSER=1 node test/dynamic-live.mjs
import http from "node:http";
import assert from "node:assert/strict";

if (process.env.FORGE_TEST_LIVE_BROWSER !== "1") {
  console.log("SKIP: dynamic-live needs a real browser. Set FORGE_TEST_LIVE_BROWSER=1 to run (downloads Chromium on first use).");
  process.exit(0);
}

const listen = (srv) => new Promise((res, rej) => {
  srv.once("error", rej);
  srv.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${srv.address().port}`));
});

// A single-page app: the STATIC html has no item links and no "RENDERED_BY_JS" marker — both appear only after
// the inline script fetches /api/items and renders. So any assertion that finds them proves real JS execution.
const SHELL = `<!doctype html><html><head><title>SPA Demo</title></head><body>
<div id="app">Loading…</div>
<script>
  fetch('/api/items?q=all').then(r => r.json()).then(d => {
    document.getElementById('app').innerHTML = d.items.map(i => '<a href="/items/' + i.id + '">' + i.name + '</a>').join('');
    const m = document.createElement('div'); m.id = 'ready'; m.textContent = 'RENDERED_BY_JS';
    document.body.appendChild(m);
  });
</script></body></html>`;

const site = http.createServer((req, res) => {
  if (req.url.startsWith("/api/items")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }, { id: 3, name: "Gamma" }] }));
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(SHELL);
});

let siteUrl;
try {
  siteUrl = await listen(site);
} catch (err) {
  if (err?.code === "EPERM") { console.log("SKIP: dynamic-live requires binding 127.0.0.1, which this sandbox blocks."); site.close(); process.exit(0); }
  throw err;
}

// localhost is SSRF-blocked by default; this is our own test server.
process.env.FORGE_ALLOW_PRIVATE_HOSTS = "1";
process.env.FORGE_BROWSER = "1";
process.env.FORGE_USE_REAL_BROWSER = "0"; // test the managed stealth ladder, not the auto real-Chrome attach
process.env.FORGE_CRAWL = "0"; // single-page capture: assertions target this one SPA, not a base-domain crawl
process.env.SCRAPER_INTERACT = "0"; // deterministic: skip the scroll/search interaction pass

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };

const BROWSER_UNAVAILABLE = /playwright-core is not installed|Executable doesn't exist|Failed to launch|browserType\.launch|ENOENT|install chromium|Download failed|net::ERR/i;

try {
  const { NodePlaywrightScraper } = await import("../dist/src/playwright-scraper.js");
  const { inferTools, HeuristicInferenceClient } = await import("@mcp/generator/lean");

  let bundle;
  try {
    bundle = await new NodePlaywrightScraper().capture(siteUrl, "safe");
  } catch (err) {
    if (BROWSER_UNAVAILABLE.test(String(err?.message || err))) {
      console.log(`SKIP: a real browser could not be launched/installed here -> ${err.message}`);
      site.close();
      process.exit(0);
    }
    throw err;
  }

  try {
    assert.equal(bundle.meta.renderedWithJs, true);
    ok("capture ran through the real browser (renderedWithJs)");
  } catch (e) { bad("renderedWithJs", e.message); }

  try {
    assert.ok(bundle.dom.html.includes("RENDERED_BY_JS"), "JS-injected marker present");
    assert.ok(/\/items\/\d/.test(bundle.dom.html), "JS-injected item links present (absent from static shell)");
    ok("JS executed: XHR-rendered DOM captured (content the static HTML never had)");
  } catch (e) { bad("JS render", e.message); }

  try {
    assert.ok(bundle.network.some((c) => /\/api\/items/.test(c.urlPattern || "") || /\/api\/items/.test(c.rawUrl || "")), "the /api/items XHR was captured");
    ok("XHR/fetch traffic captured into the bundle");
  } catch (e) { bad("XHR capture", e.message); }

  try {
    const { result } = await inferTools(bundle, new HeuristicInferenceClient());
    assert.ok(result.tools.some((t) => t.execution.kind === "http" && /\/api\/items/.test(t.execution.request.urlPattern)), "a tool was built for the captured XHR endpoint");
    ok("dynamic -> tool: captured XHR became a callable http tool");
  } catch (e) { bad("dynamic->tool", e.message); }
} catch (err) {
  bad("dynamic-live harness", err.message);
} finally {
  site.close();
}

console.log(failed === 0 ? "\nPASS: real browser renders a dynamic SPA, captures its XHR, and turns it into a tool." : `\nFAIL: ${failed} check(s).`);
process.exit(failed === 0 ? 0 : 1);
