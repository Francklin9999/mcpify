// Hermetic test for the login/CAPTCHA privacy + pause logic (no browser):
//  - redactSensitiveHtml strips credential input VALUES (password/otp/card/...) but leaves normal inputs intact.
//  - isHumanWall fires on real sign-in / CAPTCHA walls but NOT on a logged-in content page that merely contains a
//    bot-ish word (the false-positive that tripped on the live LinkedIn feed).
// Run: node test/credential-safety.mjs
import assert from "node:assert";
import { redactSensitiveHtml, isHumanWall } from "../dist/src/playwright-scraper.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.message ?? e); } }

await check("redacts password / credential input values, never keeps the secret", () => {
  const html =
    `<form>` +
    `<input type="password" value="hunter2">` +
    `<input name="session_password" value="topsecret">` +
    `<input autocomplete="current-password" value="abc123">` +
    `<input id="user_otp" value="998877">` +
    `<input name="cardNumber" value="4111111111111111">` +
    `</form>`;
  const out = redactSensitiveHtml(html);
  for (const leak of ["hunter2", "topsecret", "abc123", "998877", "4111111111111111"]) {
    assert.ok(!out.includes(leak), `secret "${leak}" must be redacted`);
  }
  assert.ok(out.includes('value="__redacted__"'), "redaction marker present");
});

await check("leaves non-credential input values untouched", () => {
  const html = `<input type="text" name="email" value="me@example.com"><input type="search" value="laptops">`;
  const out = redactSensitiveHtml(html);
  assert.ok(out.includes("me@example.com"), "email value kept");
  assert.ok(out.includes("laptops"), "search value kept");
});

await check("isHumanWall: a sign-in page (password + login title) -> true", () => {
  const html = `<h1>Sign in</h1><form><input type="password" name="pw"></form>`;
  assert.strictEqual(isHumanWall({ html, title: "Sign in to Acme", url: "https://acme.com/login" }), true);
});

await check("isHumanWall: a thin CAPTCHA/challenge page -> true", () => {
  const html = `<h1>Just a moment...</h1><p>Checking your browser before accessing the site.</p>`;
  assert.strictEqual(isHumanWall({ html, title: "Just a moment...", url: "https://x.com/" }), true);
});

await check("isHumanWall: a LONG logged-in content page with a stray bot-word -> false (no false pause)", () => {
  const filler = "Your feed has lots of authenticated content here. ".repeat(120); // >3000 visible chars
  const html = `<main><h1>Feed</h1><p>${filler}</p><!-- access denied appears in some buried script string --></main>`;
  assert.ok(html.replace(/<[^>]+>/g, " ").trim().length > 3000, "fixture is genuinely long");
  assert.strictEqual(
    isHumanWall({ html, title: "Feed | LinkedIn", url: "https://www.linkedin.com/feed/", network: [{}, {}] }),
    false,
    "a long logged-in page must NOT be treated as a human wall",
  );
});

await check("isHumanWall: a normal short content page (no markers) -> false", () => {
  const html = `<h1>Pricing</h1><p>Plans start at $9/mo.</p>`;
  assert.strictEqual(isHumanWall({ html, title: "Pricing", url: "https://acme.com/pricing" }), false);
});

console.log(failed ? `\ncredential-safety: ${failed} FAILED` : "\ncredential-safety: all passed");
process.exit(failed ? 1 : 0);
