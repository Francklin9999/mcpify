import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGate, sameTarget, emitGateRuntime, BOT_MARKERS } from "../src/browser-gate.js";
import { generateServerSource, type CodegenInput } from "../src/codegen.js";

// ---- the pure decision table (this is the logic that ships, byte-for-byte, into every server) ----

test("a normal content page is not a gate", () => {
  const g = classifyGate({ requestedUrl: "https://x.com/p/1", landedUrl: "https://x.com/p/1", title: "Product 1", text: "A great product. Add to cart." });
  assert.equal(g.kind, "ok");
});

test("captcha: an embedded challenge widget is detected (highest precision)", () => {
  const g = classifyGate({ landedUrl: "https://x.com/", title: "x", text: "loading", hasChallengeFrame: true });
  assert.equal(g.kind, "captcha");
});

test("captcha: Cloudflare / generic bot-wall text is detected", () => {
  for (const t of ["Just a moment...", "Checking your browser before accessing", "Please verify you are a human", "Enter the characters you see"]) {
    const g = classifyGate({ landedUrl: "https://x.com/", title: t, text: t });
    assert.equal(g.kind, "captcha", `should flag: ${t}`);
  }
});

test("captcha wins over auth (a challenge page can also carry a password field)", () => {
  const g = classifyGate({ landedUrl: "https://x.com/login", title: "just a moment...", text: "captcha", hasPasswordField: true, hasChallengeFrame: true });
  assert.equal(g.kind, "captcha");
});

test("auth: redirected AWAY from the requested page to a sign-in URL", () => {
  const g = classifyGate({ requestedUrl: "https://x.com/dashboard", landedUrl: "https://accounts.x.com/signin?next=/dashboard", title: "Sign in", text: "Sign in" });
  assert.equal(g.kind, "auth");
  assert.match(g.reason, /redirect/i);
});

test("auth: sitting on a sign-in URL that is actively asking for a password", () => {
  const g = classifyGate({ landedUrl: "https://x.com/login", title: "Log in", text: "Log in", hasPasswordField: true });
  assert.equal(g.kind, "auth");
});

// ---- the false-positives the design must AVOID (advisor crux: don't fire on mere presence) ----

test("NOT a gate: a normal page that merely has a login widget in the header", () => {
  // URL isn't a login route, no redirect, no login-gating copy -> a password field alone must NOT pause.
  const g = classifyGate({ requestedUrl: "https://x.com/", landedUrl: "https://x.com/", title: "Home", text: "Welcome", hasPasswordField: true });
  assert.equal(g.kind, "ok");
});

test("NOT a gate: we deliberately navigated to /login and it isn't asking for a password yet", () => {
  const g = classifyGate({ requestedUrl: "https://x.com/login", landedUrl: "https://x.com/login", title: "Login", text: "Login" });
  assert.equal(g.kind, "ok");
});

test("sameTarget ignores trailing slash and hash, distinguishes real path changes", () => {
  assert.equal(sameTarget("https://x.com/a/", "https://x.com/a#frag"), true);
  assert.equal(sameTarget("https://x.com/a", "https://x.com/b"), false);
  assert.equal(sameTarget("https://x.com/dash", "https://login.x.com/dash"), false);
});

// ---- serialization: the emitted runtime carries the SAME tables/logic (single source of truth) ----

test("emitGateRuntime serializes the tables and both functions under their runtime names", () => {
  const src = emitGateRuntime();
  for (const m of BOT_MARKERS) assert.ok(src.includes(JSON.stringify(m).slice(1, -1)), `marker emitted: ${m}`);
  assert.match(src, /const classifyGate: \(s: any\)/);
  assert.match(src, /const sameTarget: \(a: any, b: any\)/);
  assert.match(src, /CHALLENGE_FRAME_SELECTORS/);
  // No NESTED arrows in the emitted bodies (they'd break noImplicitAny in the strict server).
  const bodies = src.split("const sameTarget")[1] || "";
  assert.ok(!/=>\s*[^=]*=>/.test(bodies.replace(/\(s: any\) =>|\(a: any, b: any\) =>/g, "")), "no nested arrows in emitted gate functions");
});

// ---- the generated server actually wires the handoff + stealth ----

function browserInput(): CodegenInput {
  return { serverId: "11111111-1111-4111-8111-111111111111", version: 1, url: "https://shop.example.com/", title: "Shop", tools: [], browsing: true };
}

test("generated server emits the human-handoff + stealth + resume wiring", () => {
  const src = generateServerSource(browserInput());
  // The resume tool the agent calls after the human finishes.
  assert.match(src, /"browser_resume"/);
  assert.match(src, /browsing\.resume/);
  // Stealth defaults.
  assert.match(src, /--disable-blink-features=AutomationControlled/);
  assert.match(src, /navigator,\s*"webdriver"/);
  assert.match(src, /launchPersistentContext/);
  assert.match(src, /MCP_BROWSER_PROFILE/);
  assert.match(src, /MCP_BROWSER_DRIVER/);
  // The pause contract the agent sees, and the gate detector.
  assert.match(src, /PAUSED - human action needed/);
  assert.match(src, /classifyGate/);
  assert.match(src, /ensureHeaded/);
});

test("generated server still emits gate wiring even with only an http tool (browsing forced)", () => {
  const src = generateServerSource({ ...browserInput(), browsing: true, tools: [] });
  assert.match(src, /classifyGateLive/);
});
