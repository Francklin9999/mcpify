// Hermetic test for real-profile login reuse: defaultUserDataDir per OS, the resolveProfile precedence
// (off by default / explicit path / no-channel skip / clone), and that cloneProfile copies session files but
// skips caches and live-instance locks. No browser is launched. Run: node test/browser-profile.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultUserDataDir, resolveProfile, cloneProfile } from "../dist/src/browser-profile.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.message ?? e); } }

const savedEnv = { ...process.env };
const resetEnv = () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  for (const k of Object.keys(savedEnv)) process.env[k] = savedEnv[k];
};

// A throwaway "User Data" source with a logged-in-looking profile plus cache/lock noise that must NOT be copied.
function makeFakeUserData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "urlmcp-src-"));
  fs.writeFileSync(path.join(root, "Local State"), '{"os_crypt":{"encrypted_key":"fake"}}');
  const def = path.join(root, "Default");
  fs.mkdirSync(path.join(def, "Network"), { recursive: true });
  fs.writeFileSync(path.join(def, "Cookies"), "SQLITE-COOKIES");
  fs.writeFileSync(path.join(def, "Network", "Cookies"), "SQLITE-NET-COOKIES");
  fs.writeFileSync(path.join(def, "Preferences"), "{}");
  fs.mkdirSync(path.join(def, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(def, "Cache", "data_0"), "x".repeat(1024));
  fs.writeFileSync(path.join(root, "SingletonLock"), "");
  return root;
}

await check("defaultUserDataDir returns an OS-appropriate Chrome/Edge path", () => {
  const chrome = defaultUserDataDir("chrome");
  const edge = defaultUserDataDir("msedge");
  assert.ok(chrome && edge && chrome !== edge, "chrome and edge dirs differ and are set");
  if (process.platform === "linux") {
    assert.ok(chrome.endsWith(path.join(".config", "google-chrome")), `linux chrome dir: ${chrome}`);
    assert.ok(edge.endsWith(path.join(".config", "microsoft-edge")), `linux edge dir: ${edge}`);
  } else if (process.platform === "darwin") {
    assert.ok(chrome.includes(path.join("Google", "Chrome")), `mac chrome dir: ${chrome}`);
  } else if (process.platform === "win32") {
    assert.ok(/User Data$/.test(chrome), `win chrome dir: ${chrome}`);
  }
});

await check("resolveProfile is OFF by default and for falsey values", () => {
  for (const v of [undefined, "", "0", "off", "false", "no"]) {
    if (v === undefined) delete process.env["FORGE_BROWSER_PROFILE"];
    else process.env["FORGE_BROWSER_PROFILE"] = v;
    assert.strictEqual(resolveProfile("chrome"), undefined, `off for ${JSON.stringify(v)}`);
  }
  resetEnv();
});

await check("resolveProfile honors an explicit absolute path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "urlmcp-explicit-"));
  process.env["FORGE_BROWSER_PROFILE"] = dir;
  process.env["FORGE_BROWSER_PROFILE_NAME"] = "Profile 1";
  const r = resolveProfile("chrome");
  assert.deepStrictEqual(r, { userDataDir: dir, profileDirectory: "Profile 1", mode: "path" });
  resetEnv();
});

await check("resolveProfile skips (returns undefined) when no real channel is detected", () => {
  process.env["FORGE_BROWSER_PROFILE"] = "clone";
  assert.strictEqual(resolveProfile(undefined), undefined, "no channel -> fresh profile");
  resetEnv();
});

await check("resolveProfile clone copies session files, skips caches + locks, and is reused", () => {
  const src = makeFakeUserData();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "urlmcp-home-"));
  process.env["URLMCP_HOME"] = home;
  process.env["FORGE_BROWSER_PROFILE"] = "clone";
  process.env["FORGE_BROWSER_PROFILE_SRC"] = src;
  process.env["FORGE_BROWSER_PROFILE_NAME"] = "Default";

  const r = resolveProfile("chrome");
  assert.ok(r && r.mode === "clone", "clone mode resolved");
  assert.strictEqual(r.profileDirectory, "Default");
  assert.strictEqual(r.userDataDir, path.join(home, "browser-profile", "chrome"));

  const dest = r.userDataDir;
  assert.ok(fs.existsSync(path.join(dest, "Local State")), "Local State copied (carries os_crypt key)");
  assert.ok(fs.existsSync(path.join(dest, "Default", "Cookies")), "Cookies copied");
  assert.ok(fs.existsSync(path.join(dest, "Default", "Network", "Cookies")), "Network/Cookies copied");
  assert.ok(!fs.existsSync(path.join(dest, "Default", "Cache")), "Cache skipped");
  assert.ok(!fs.existsSync(path.join(dest, "SingletonLock")), "SingletonLock skipped");

  // Second call must reuse the existing clone (no throw, same dir) rather than re-copying.
  const r2 = resolveProfile("chrome");
  assert.strictEqual(r2.userDataDir, dest, "clone reused on second resolve");
  resetEnv();
});

await check("resolveProfile clone throws a clear error for a missing profile name", () => {
  const src = makeFakeUserData();
  process.env["URLMCP_HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "urlmcp-home2-"));
  process.env["FORGE_BROWSER_PROFILE"] = "clone";
  process.env["FORGE_BROWSER_PROFILE_SRC"] = src;
  process.env["FORGE_BROWSER_PROFILE_NAME"] = "Nope";
  assert.throws(() => resolveProfile("chrome"), /not found/i);
  resetEnv();
});

// Direct cloneProfile unit: filter excludes caches, copies the rest.
await check("cloneProfile copies the chosen profile + Local State only", () => {
  const src = makeFakeUserData();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "urlmcp-clone-")), "User Data");
  cloneProfile(src, dest, "Default");
  assert.ok(fs.existsSync(path.join(dest, "Default", "Preferences")), "Preferences copied");
  assert.ok(!fs.existsSync(path.join(dest, "Default", "Cache", "data_0")), "cache file skipped");
});

console.log(failed ? `\nbrowser-profile: ${failed} FAILED` : "\nbrowser-profile: all passed");
process.exit(failed ? 1 : 0);
