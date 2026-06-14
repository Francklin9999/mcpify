// Real CDP-attach test: launch a Chromium with --remote-debugging-port (standing in for the user's already-running,
// already-signed-in browser), point FORGE_BROWSER_CDP at it, and prove urlmcp ATTACHES to that live browser instead
// of launching its own — capturing the page + its XHR in the existing session, and leaving the host browser alive
// (urlmcp must only disconnect, never kill a browser it didn't start).
//
// Needs a real Chromium. To keep `npm test` fast + CI-safe this self-SKIPS unless FORGE_TEST_LIVE_BROWSER=1:
//   FORGE_TEST_LIVE_BROWSER=1 node test/cdp-attach-live.mjs
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";

if (process.env.FORGE_TEST_LIVE_BROWSER !== "1") {
  console.log("SKIP: cdp-attach-live needs a real browser. Set FORGE_TEST_LIVE_BROWSER=1 to run.");
  process.exit(0);
}

// A core Playwright driver to HOST the browser we attach to. If none is installed, skip.
let pwCore;
try {
  pwCore = (await import("playwright-core")).chromium;
} catch {
  console.log("SKIP: cdp-attach-live needs playwright-core installed.");
  process.exit(0);
}
const exe = pwCore.executablePath?.();
if (!exe) {
  console.log("SKIP: cdp-attach-live found no Chromium binary (run: npx playwright install chromium).");
  process.exit(0);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const listen = (srv) =>
  new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${srv.address().port}`));
  });

const page = `<!doctype html><html><head><title>Attach Target</title></head><body>
<h1>Hello from the attached session</h1>
<p>${"Real content rendered in the user's own browser. ".repeat(20)}</p>
<script>fetch("/api/data").catch(function(){});</script>
</body></html>`;
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/api/data")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"items":[1,2,3]}'); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page);
});

let siteUrl;
try {
  siteUrl = await listen(site);
} catch (err) {
  if (err?.code === "EPERM") { console.log("SKIP: cdp-attach-live requires binding 127.0.0.1, which this sandbox blocks."); site.close(); process.exit(0); }
  throw err;
}

const dbgPort = await freePort();
process.env.FORGE_ALLOW_PRIVATE_HOSTS = "1"; // our own loopback site + CDP endpoint
process.env.FORGE_BROWSER_CDP = String(dbgPort);
process.env.SCRAPER_INTERACT = "0";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e?.stack ?? e}`); };

// Launch the "user's browser" with a DevTools port exposed.
const host = await pwCore.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", `--remote-debugging-port=${dbgPort}`] });
// Give the host a real, signed-in-looking context page so contexts()[0] exists for the attach to reuse.
const hostCtx = host.contexts()[0] ?? (await host.newContext());
await hostCtx.newPage();

try {
  const { NodePlaywrightScraper } = await import("../dist/src/playwright-scraper.js");
  const scraper = new NodePlaywrightScraper();
  const bundle = await scraper.capture(siteUrl, "safe");

  try {
    assert.equal(bundle.tier, 4, "attach capture is tier 4");
    assert.ok(bundle.dom.html.includes("attached session"), "captured the page rendered in the attached browser");
    assert.ok(bundle.network.some((c) => /\/api\/data$/.test(c.urlPattern)), "captured the page's XHR in the attached session");
    ok("attached to the live browser and captured page + XHR");
  } catch (e) { bad("attach capture", e); }

  try {
    assert.ok(host.isConnected(), "host browser still connected (urlmcp only disconnected)");
    await host.newPage(); // still drivable
    ok("host browser stayed alive after capture (not killed)");
  } catch (e) { bad("host survival", e); }
} finally {
  await host.close().catch(() => {});
  site.close();
}

console.log(failed ? `\ncdp-attach-live: ${failed} FAILED` : "\ncdp-attach-live: all passed");
process.exit(failed ? 1 : 0);
