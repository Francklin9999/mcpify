// Hermetic unit test (no browser) for the stealth escalation ladder + blocked-page detection.
// Run: node test/stealth-ladder.mjs
import assert from "node:assert";
import { planBrowserAttempts, looksBlocked, BOT_MARKERS } from "../dist/src/playwright-scraper.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }

const saved = { ...process.env };
const reset = () => {
  for (const k of ["FORGE_BROWSER_ESCALATE", "MCP_BROWSER_HEADLESS", "MCP_BROWSER_CHANNEL", "MCP_BROWSER_DRIVER", "MCP_BROWSER_PATH", "DISPLAY", "WAYLAND_DISPLAY"]) delete process.env[k];
};

await check("FORGE_BROWSER_ESCALATE=0 -> exactly one attempt (no escalation)", async () => {
  reset();
  process.env.FORGE_BROWSER_ESCALATE = "0";
  const a = await planBrowserAttempts();
  assert.strictEqual(a.length, 1, `expected 1 attempt, got ${a.length}`);
});

await check("escalation on -> a ladder of distinct rungs, ending headful when a display exists", async () => {
  reset();
  process.env.DISPLAY = ":0"; // pretend a display is present
  const a = await planBrowserAttempts();
  assert.ok(a.length >= 1, "at least one attempt");
  // rungs are unique
  const keys = a.map((x) => `${x.driver}|${x.channel ?? ""}|${x.headless}`);
  assert.strictEqual(new Set(keys).size, keys.length, "rungs must be deduped/distinct");
  // with a display, the last rung is headful (the strongest stealth signal)
  assert.strictEqual(a[a.length - 1].headless, false, "last rung should be headful when a display is available");
});

await check("no display -> ladder never proposes a headful rung", async () => {
  reset(); // no DISPLAY/WAYLAND on Linux
  const a = await planBrowserAttempts();
  if (process.platform === "linux") {
    assert.ok(a.every((x) => x.headless === true), "all rungs headless without a display on linux");
  } else {
    assert.ok(a.length >= 1); // macOS/Windows always have a display
  }
});

await check("forced MCP_BROWSER_DRIVER -> stealth driver used on the first rung", async () => {
  reset();
  process.env.MCP_BROWSER_DRIVER = "rebrowser-playwright-core";
  const a = await planBrowserAttempts();
  assert.strictEqual(a[0].driver, "stealth", "explicit driver must be honored");
});

await check("forced MCP_BROWSER_CHANNEL flows into every rung", async () => {
  reset();
  process.env.MCP_BROWSER_CHANNEL = "chrome";
  const a = await planBrowserAttempts();
  assert.ok(a.every((x) => x.channel === "chrome"), "forced channel on all rungs");
});

await check("MCP_BROWSER_HEADLESS=0 -> base attempt is headful", async () => {
  reset();
  process.env.MCP_BROWSER_HEADLESS = "0";
  const a = await planBrowserAttempts();
  assert.strictEqual(a[0].headless, false, "headless=0 forces a headful base rung");
});

process.env = saved;

// --- looksBlocked / BOT_MARKERS ---
const bundle = (html, network = [], title = "") => ({
  bundleId: "33333333-3333-4333-8333-333333333333",
  source: "scraper", url: "https://x.example", capturedAt: "2026-06-10T00:00:00.000Z",
  legalMode: "safe", tier: 2, dom: { html, domHash: "sha256:x" }, network, meta: { title, renderedWithJs: true },
});

check("captcha / challenge page is detected as blocked", () => {
  assert.ok(looksBlocked(bundle("<html><body>Please verify you are human to continue.</body></html>")));
  assert.ok(looksBlocked(bundle("<html><body>Just a moment...</body></html>", [], "Just a moment...")));
  assert.ok(BOT_MARKERS.test("Sorry! Something went wrong on our end."));
});

check("near-empty shell with no captured API is treated as blocked (escalate)", () => {
  assert.ok(looksBlocked(bundle("<html><body><div id=app></div></body></html>", [])));
});

check("a rendered page with captured API traffic is NOT blocked", () => {
  const rich = "<html><body>" + "Lots of real product content here. ".repeat(60) + "</body></html>";
  assert.ok(!looksBlocked(bundle(rich, [{ method: "GET", urlPattern: "/api/items", rawUrl: "https://x.example/api/items", requestHeaders: {}, statusCode: 200, contentType: "application/json" }])));
});

console.log(failed === 0 ? "\nPASS: stealth ladder plans correctly + blocked-page detection holds." : `\nFAIL: ${failed} check(s).`);
process.exit(failed === 0 ? 0 : 1);
