// Unit check (no network/browser): chooseScraper picks the right strategy by env. Run: node test/scraper-select.mjs
import assert from "node:assert";
import { chooseScraper } from "../dist/src/scraper.js";
import { playwrightAvailable } from "../dist/src/playwright-scraper.js";

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} -> ${e.message}`);
  }
};

const saved = { ...process.env };
const reset = () => {
  for (const k of ["SCRAPER_URL", "FORGE_BROWSER"]) delete process.env[k];
};

reset();
check("default (no env) -> in-process escalating browser scraper", () => {
  assert.strictEqual(chooseScraper().kind, "browser");
});

reset();
process.env.FORGE_BROWSER = "0";
check("FORGE_BROWSER=0 -> static-only", () => {
  assert.strictEqual(chooseScraper().kind, "static");
});

reset();
process.env.SCRAPER_URL = "http://localhost:8000";
check("SCRAPER_URL set -> remote Python scraper wins", () => {
  assert.strictEqual(chooseScraper().kind, "http-service");
});

reset();
check("every strategy exposes a capture(url, legalMode) method", () => {
  assert.strictEqual(typeof chooseScraper().scraper.capture, "function");
});

await check("playwrightAvailable() resolves to a boolean (no throw when chromium absent)", async () => {
  // FORGE_BROWSER=0 short-circuits to false without trying to launch - deterministic + fast.
  process.env.FORGE_BROWSER = "0";
  const ok = await playwrightAvailable();
  assert.strictEqual(typeof ok, "boolean");
});

process.env = saved;
console.log(failed === 0 ? "PASS: chooseScraper selects the right strategy across env combinations." : `FAIL: ${failed} case(s).`);
process.exit(failed === 0 ? 0 : 1);
