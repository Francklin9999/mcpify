// Real auth/CAPTCHA-handoff test: drives the in-process stealth browser against a LOCAL sign-in wall that
// "auto-logs-in" after a few seconds (a stand-in for a human completing the login in the open window). It proves
// the handoff end to end: the ladder hits a wall a human must clear -> a visible browser opens -> urlmcp waits ->
// once the wall is gone it CONTINUES capturing the now-authenticated page (post-login content + its XHR) in the
// SAME session.
//
// Needs a real Chromium + a display (the handoff is headful). To keep `npm test` fast + headless-CI-safe this
// self-SKIPS unless FORGE_TEST_LIVE_BROWSER=1. Run it explicitly with:
//   FORGE_TEST_LIVE_BROWSER=1 node test/auth-handoff-live.mjs
import http from "node:http";
import assert from "node:assert/strict";

if (process.env.FORGE_TEST_LIVE_BROWSER !== "1") {
  console.log("SKIP: auth-handoff-live needs a real browser + display. Set FORGE_TEST_LIVE_BROWSER=1 to run.");
  process.exit(0);
}

const listen = (srv) =>
  new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${srv.address().port}`));
  });

const filler = "Please sign in to view your dashboard. ".repeat(20);
// A real sign-in wall: a password field + login title, with enough text that it isn't mistaken for a thin
// bot-shell. Its inline script navigates to /app after 3.5s, standing in for the human finishing the login.
const loginPage = `<!doctype html><html><head><title>Sign in to Acme</title></head><body>
<h1>Sign in</h1><p>${filler}</p>
<form><input name="email" placeholder="email"><input type="password" name="pw"><button>Sign in</button></form>
<script>setTimeout(function(){ location.href = "/app"; }, 3500);</script>
</body></html>`;
const appPage = `<!doctype html><html><head><title>Your Dashboard</title></head><body>
<h1>Dashboard</h1><p>${"Authenticated content only visible after sign-in. ".repeat(40)}</p>
<script>fetch("/api/me").catch(function(){});</script>
</body></html>`;

const site = http.createServer((req, res) => {
  if (req.url.startsWith("/app")) { res.writeHead(200, { "content-type": "text/html" }); res.end(appPage); return; }
  if (req.url.startsWith("/api/me")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"user":"acme","plan":"pro"}'); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(loginPage); // / and /login -> the wall
});

let siteUrl;
try {
  siteUrl = await listen(site);
} catch (err) {
  if (err?.code === "EPERM") { console.log("SKIP: auth-handoff-live requires binding 127.0.0.1, which this sandbox blocks."); site.close(); process.exit(0); }
  throw err;
}

process.env.FORGE_ALLOW_PRIVATE_HOSTS = "1"; // our own loopback test server
process.env.FORGE_USE_REAL_BROWSER = "0";    // test the MANAGED headful handoff, not the auto real-Chrome attach
process.env.FORGE_CRAWL = "0";               // single-page: assert the handoff on this login page, no base-domain crawl
process.env.FORGE_BROWSER_ESCALATE = "0";    // one headless attempt -> wall -> handoff (fast + deterministic)
process.env.FORGE_AUTH_HANDOFF = "1";
process.env.FORGE_AUTH_HANDOFF_TIMEOUT_MS = "25000";
process.env.FORGE_AUTH_POLL_MS = "500";
process.env.SCRAPER_INTERACT = "0";
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === "linux") process.env.DISPLAY = ":0";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };

try {
  const { NodePlaywrightScraper } = await import("../dist/src/playwright-scraper.js");
  const bundle = await new NodePlaywrightScraper().capture(`${siteUrl}/login`, "safe");
  const html = bundle.dom.html || "";

  if (/Dashboard|Authenticated content/.test(html)) ok("captured the POST-login page, not the sign-in wall");
  else bad("captured post-login page", "final DOM still looks like the login wall");

  if (!/type=["']?password/.test(html)) ok("final capture has no password field (we got past the wall)");
  else bad("past the wall", "password field still present in the captured DOM");

  if (bundle.meta?.renderedWithJs && bundle.tier === 4) ok("handoff used the headful (tier 4) browser path");
  else bad("headful handoff path", `renderedWithJs=${bundle.meta?.renderedWithJs} tier=${bundle.tier}`);

  if (bundle.network.some((n) => /\/api\/me/.test(n.rawUrl))) ok("captured the /api/me XHR that only fires after sign-in");
  else bad("post-login XHR captured", "did not capture /api/me (the authenticated request)");
} catch (err) {
  bad("auth handoff capture", err?.message ?? String(err));
} finally {
  site.close();
}

console.log(failed === 0 ? "\nPASS: auth/CAPTCHA handoff waits for the human, then continues capturing the authenticated session." : `\nFAIL: ${failed} check(s).`);
process.exit(failed === 0 ? 0 : 1);
