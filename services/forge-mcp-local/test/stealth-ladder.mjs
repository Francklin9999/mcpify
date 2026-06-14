// Hermetic unit test (no browser) for the stealth escalation ladder + blocked-page detection.
// Run: node test/stealth-ladder.mjs
import assert from "node:assert";
import { planBrowserAttempts, looksBlocked, needsHuman, hasLoginWall, BOT_MARKERS } from "../dist/src/playwright-scraper.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }

const saved = { ...process.env };
const reset = () => {
  for (const k of ["MCP_BROWSER_HEADLESS", "MCP_BROWSER_CHANNEL", "MCP_BROWSER_DRIVER", "MCP_BROWSER_PATH", "DISPLAY", "WAYLAND_DISPLAY"]) delete process.env[k];
};

// STEALTH MAX: planBrowserAttempts always returns a SINGLE strongest attempt — no cheap-first ladder, no tiers.
await check("always exactly one attempt (no ladder)", async () => {
  reset();
  assert.strictEqual((await planBrowserAttempts()).length, 1, "one attempt");
  process.env.DISPLAY = ":0";
  assert.strictEqual((await planBrowserAttempts()).length, 1, "still one attempt with a display");
});

await check("with a display -> the single attempt is HEADFUL (strongest stealth)", async () => {
  reset();
  process.env.DISPLAY = ":0"; // pretend a display is present
  const a = await planBrowserAttempts();
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].headless, false, "headful when a display is available");
});

await check("no display -> the single attempt is headless (headful impossible)", async () => {
  reset(); // no DISPLAY/WAYLAND on Linux
  const a = await planBrowserAttempts();
  if (process.platform === "linux") {
    assert.strictEqual(a[0].headless, true, "headless without a display on linux");
  } else {
    assert.strictEqual(a.length, 1); // macOS/Windows always have a display
  }
});

await check("forced MCP_BROWSER_DRIVER -> stealth driver used", async () => {
  reset();
  process.env.MCP_BROWSER_DRIVER = "rebrowser-playwright-core";
  const a = await planBrowserAttempts();
  assert.strictEqual(a[0].driver, "stealth", "explicit driver must be honored");
});

await check("forced MCP_BROWSER_CHANNEL flows into the attempt", async () => {
  reset();
  process.env.MCP_BROWSER_CHANNEL = "chrome";
  const a = await planBrowserAttempts();
  assert.strictEqual(a[0].channel, "chrome", "forced channel honored");
});

await check("MCP_BROWSER_HEADLESS override wins (1 forces headless even with a display)", async () => {
  reset();
  process.env.DISPLAY = ":0";
  process.env.MCP_BROWSER_HEADLESS = "1";
  assert.strictEqual((await planBrowserAttempts())[0].headless, true, "headless=1 forces headless");
  process.env.MCP_BROWSER_HEADLESS = "0";
  assert.strictEqual((await planBrowserAttempts())[0].headless, false, "headless=0 forces headful");
});

process.env = saved;

// --- looksBlocked / BOT_MARKERS ---
const bundle = (html, network = [], title = "", url = "https://x.example") => ({
  bundleId: "33333333-3333-4333-8333-333333333333",
  source: "scraper", url, capturedAt: "2026-06-10T00:00:00.000Z",
  legalMode: "safe", tier: 2, dom: { html, domHash: "sha256:x" }, network, meta: { title, renderedWithJs: true },
});

await check("captcha / challenge page is detected as blocked", () => {
  assert.ok(looksBlocked(bundle("<html><body>Please verify you are human to continue.</body></html>")));
  assert.ok(looksBlocked(bundle("<html><body>Just a moment...</body></html>", [], "Just a moment...")));
  assert.ok(BOT_MARKERS.test("Sorry! Something went wrong on our end."));
});

await check("near-empty shell with no captured API is treated as blocked (escalate)", () => {
  assert.ok(looksBlocked(bundle("<html><body><div id=app></div></body></html>", [])));
});

await check("a rendered page with captured API traffic is NOT blocked", () => {
  const rich = "<html><body>" + "Lots of real product content here. ".repeat(60) + "</body></html>";
  assert.ok(!looksBlocked(bundle(rich, [{ method: "GET", urlPattern: "/api/items", rawUrl: "https://x.example/api/items", requestHeaders: {}, statusCode: 200, contentType: "application/json" }])));
});

// --- hasLoginWall / needsHuman (auth handoff trigger) ---
const richContent = "Lots of real product content here. ".repeat(60);
const loginForm = '<form><input name="email"><input type="password" name="pw"><button>Sign in</button></form>';

await check("a thin sign-in page (password field) is a login wall + needsHuman", () => {
  const html = `<html><body><h1>Sign in</h1>${loginForm}</body></html>`;
  assert.ok(hasLoginWall(bundle(html, [], "Sign in to Acme")), "login title + password => wall");
  assert.ok(needsHuman(bundle(html, [], "Sign in to Acme")), "login wall needs a human");
  // login is detectable from the URL too, even without a login-y title
  assert.ok(hasLoginWall(bundle(html, [], "", "https://acme.com/account/login")), "login URL + password => wall");
});

await check("a password field is NOT a wall if the URL/title aren't login-y", () => {
  // A content page with a password field buried in a header dropdown, lots of real content, neutral title/url.
  const html = `<html><body>${richContent}<div class="header-login">${loginForm}</div>${richContent}</body></html>`;
  assert.ok(!hasLoginWall(bundle(html, [], "Acme — Best Widgets", "https://acme.com/widgets/123")), "content page w/ login dropdown is not a wall");
});

await check("a normal content page needs no human", () => {
  const html = `<html><body>${richContent}</body></html>`;
  assert.ok(!needsHuman(bundle(html, [{ method: "GET", urlPattern: "/api/x", rawUrl: "https://x.example/api/x", requestHeaders: {}, statusCode: 200, contentType: "application/json" }])));
});

await check("a CAPTCHA page needs a human (via looksBlocked)", () => {
  assert.ok(needsHuman(bundle("<html><body>Please verify you are human.</body></html>")));
});

await check("a thin SSR shell does NOT need a human (escalate the ladder, don't summon a person)", () => {
  // <500 chars + no network => looksBlocked (escalate) but NOT needsHuman (no false 5-min handoff wait).
  const thin = bundle("<html><body><div id=app></div></body></html>", []);
  assert.ok(looksBlocked(thin), "thin shell is treated as blocked (mine what we can, don't summon a person)");
  assert.ok(!needsHuman(thin), "thin shell must NOT trigger the human handoff");
});

await check("LinkedIn/X-style auth INTERSTITIAL (no password field yet) is a login wall + needsHuman", () => {
  // The logged-out gate LinkedIn/X/Instagram serve: a thin page, an explicit "sign in to continue" CTA, no
  // password input in the initial DOM, no API traffic. PASSWORD_FIELD alone misses it; the interstitial path catches it.
  const li = `<html><head><title>LinkedIn</title></head><body><h1>Welcome back</h1>
    <p>Sign in to continue to LinkedIn. New to LinkedIn? Join now.</p>
    <a href="/login">Sign in</a></body></html>`;
  assert.ok(!/type=["']?password/i.test(li), "fixture has no password field (the realistic logged-out DOM)");
  assert.ok(hasLoginWall(bundle(li, [], "LinkedIn", "https://www.linkedin.com/feed/")), "auth interstitial detected as a login wall");
  assert.ok(needsHuman(bundle(li, [], "LinkedIn", "https://www.linkedin.com/feed/")), "interstitial needs a human");
});

await check("an auth path URL (/authwall, /uas/login) is recognized", () => {
  const html = `<html><body><h1>Sign in</h1><form><input type="password" name="pw"></form></body></html>`;
  assert.ok(hasLoginWall(bundle(html, [], "Sign in", "https://www.linkedin.com/authwall?trk=x")), "/authwall recognized");
});

await check("a CONTENT page that merely contains 'join now' in its body does NOT trip the interstitial path", () => {
  // Lots of real content + captured API + a marketing 'join now' line => must NOT be a wall (no false handoff).
  const html = `<html><body>${"Real article content about widgets and gadgets. ".repeat(80)}<a>Join now</a></body></html>`;
  const b = bundle(html, [{ method: "GET", urlPattern: "/api/x", rawUrl: "https://x.example/api/x", requestHeaders: {}, statusCode: 200, contentType: "application/json" }], "Widgets — Article");
  assert.ok(!hasLoginWall(b), "rich content page with a 'join now' link is not an auth wall");
  assert.ok(!needsHuman(b), "rich content page must not summon a human");
});

console.log(failed === 0 ? "\nPASS: stealth ladder plans + blocked/login-wall detection + auth-handoff triggers hold." : `\nFAIL: ${failed} check(s).`);
process.exit(failed === 0 ? 0 : 1);
