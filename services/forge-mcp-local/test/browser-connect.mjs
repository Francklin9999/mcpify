// Hermetic test for CDP-attach target parsing: FORGE_BROWSER_CDP -> CdpTarget. Covers off-by-default, the
// endpoint normalizations (bare port / host:port / http / ws), the "launch" keywords, and junk -> undefined.
// No browser is launched. Run: node test/browser-connect.mjs
import assert from "node:assert";
import { cdpTargetFromEnv, describeCdpTarget } from "../dist/src/browser-connect.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.message ?? e); } }

const T = (v) => cdpTargetFromEnv({ FORGE_BROWSER_CDP: v });

await check("off by default and for falsey values", () => {
  assert.strictEqual(cdpTargetFromEnv({}), undefined, "unset -> off");
  for (const v of ["", "0", "off", "false", "no", "OFF"]) assert.strictEqual(T(v), undefined, `off for ${JSON.stringify(v)}`);
});

await check("bare port -> loopback http endpoint", () => {
  assert.deepStrictEqual(T("9222"), { kind: "endpoint", endpoint: "http://127.0.0.1:9222" });
  assert.deepStrictEqual(T("47800"), { kind: "endpoint", endpoint: "http://127.0.0.1:47800" });
});

await check("host:port -> http endpoint", () => {
  assert.deepStrictEqual(T("localhost:9222"), { kind: "endpoint", endpoint: "http://localhost:9222" });
  assert.deepStrictEqual(T("127.0.0.1:9333"), { kind: "endpoint", endpoint: "http://127.0.0.1:9333" });
});

await check("explicit http/https/ws/wss endpoints pass through unchanged", () => {
  for (const e of ["http://127.0.0.1:9222", "https://host.example:9222", "ws://127.0.0.1:9222/devtools/browser/abc", "wss://x/y"]) {
    assert.deepStrictEqual(T(e), { kind: "endpoint", endpoint: e }, e);
  }
});

await check('launch keywords -> { kind: "launch" }', () => {
  for (const v of ["launch", "auto", "1", "on", "true", "yes", "LAUNCH"]) assert.deepStrictEqual(T(v), { kind: "launch" }, v);
});

await check("non-endpoint junk -> undefined (not a silent misconnect)", () => {
  for (const v of ["nonsense", "chrome", "http://", "::::"]) assert.strictEqual(T(v), undefined, `junk ${JSON.stringify(v)}`);
});

await check("describeCdpTarget is human-readable for both kinds", () => {
  assert.match(describeCdpTarget({ kind: "launch" }), /launch/i);
  assert.match(describeCdpTarget({ kind: "endpoint", endpoint: "http://127.0.0.1:9222" }), /9222/);
});

console.log(failed ? `\nbrowser-connect: ${failed} FAILED` : "\nbrowser-connect: all passed");
process.exit(failed ? 1 : 0);
