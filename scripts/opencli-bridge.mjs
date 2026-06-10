#!/usr/bin/env node
/**
 * Stealth opencli Browser Bridge launcher.
 *
 * Brings up a real Chrome wired to the opencli daemon, with anti-automation hardening so opencli-driven
 * browsing (the "advanced" backend used by forge for dynamic / bot-walled sites) is not FALSELY flagged as a
 * bot. It:
 *   1. ensures the opencli daemon is running,
 *   2. fetches + caches the opencli Browser Bridge extension from the GitHub release (it is NOT in the npm pkg),
 *   3. launches Chrome with a PERSISTENT profile (so clearance cookies + logins survive across runs) and a set
 *      of stealth flags,
 *   4. loads BOTH the opencli bridge extension and the bundled stealth content-script extension via the CDP
 *      pipe (`Extensions.loadUnpacked`) — required because Chrome 137+ ignores `--load-extension` on the
 *      command line,
 *   5. verifies `navigator.webdriver === false`,
 *   6. stays alive holding the CDP pipe (closing it unloads the extensions), until Ctrl-C.
 *
 * Honest scope: this is fingerprint hygiene for YOUR OWN browser, not a CAPTCHA solver. It stops the common
 * automation tells; it does not defeat behavioral analysis or IP reputation. Against PerimeterX (e.g.
 * Skyscanner) the reliable lever is a WARM profile (solve the challenge once; clearance is banked in this
 * persistent profile) and/or a residential IP. See docs/OPENCLI_BACKEND.md.
 *
 * Usage:
 *   node scripts/opencli-bridge.mjs [--profile <dir>] [--headful] [--url <startUrl>] [--no-stealth]
 *   OPENCLI_BRIDGE_PROFILE=<dir> node scripts/opencli-bridge.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const HOME = join(homedir(), ".opencli-bridge");
const PROFILE = opt("--profile", process.env.OPENCLI_BRIDGE_PROFILE || join(HOME, "profile"));
const EXT_CACHE = join(HOME, "opencli-ext");
const STEALTH_EXT = join(__dirname, "stealth-extension");
const START_URL = opt("--url", "about:blank");
const USE_STEALTH = !flag("--no-stealth");
const RELEASE_ZIP = "https://github.com/jackwener/OpenCLI/releases/download/v1.8.2/opencli-extension-v1.0.18.zip";

const log = (...a) => console.log("[bridge]", ...a);
const die = (msg) => { console.error("[bridge] ERROR:", msg); process.exit(1); };

function findChrome() {
  const candidates = [
    process.env.OPENCLI_CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  die("no Chrome/Chromium found (set OPENCLI_CHROME=/path/to/chrome)");
}

function resolveOpencli() {
  for (const c of [process.env.MCP_OPENCLI_BIN, "opencli"].filter(Boolean)) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  die("opencli not found on PATH (npm i -g @jackwener/opencli)");
}

async function ensureExtension() {
  if (existsSync(join(EXT_CACHE, "manifest.json"))) { log("opencli extension cached:", EXT_CACHE); return EXT_CACHE; }
  log("fetching opencli bridge extension:", RELEASE_ZIP);
  mkdirSync(EXT_CACHE, { recursive: true });
  const zipPath = join(tmpdir(), "opencli-ext-" + Date.now() + ".zip");
  const res = await fetch(RELEASE_ZIP);
  if (!res.ok) die("failed to download extension: HTTP " + res.status);
  const { Readable } = await import("node:stream");
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(zipPath);
    Readable.fromWeb(res.body).pipe(ws).on("finish", resolve).on("error", reject);
  });
  const unzip = spawnSync("unzip", ["-oq", zipPath, "-d", EXT_CACHE], { encoding: "utf8" });
  if (unzip.status !== 0) die("unzip failed: " + unzip.stderr);
  if (!existsSync(join(EXT_CACHE, "manifest.json"))) {
    const entries = await readdir(EXT_CACHE, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(EXT_CACHE, e.name, "manifest.json"))) return join(EXT_CACHE, e.name);
    }
    die("extension manifest.json not found after unzip");
  }
  log("opencli extension ready:", EXT_CACHE);
  return EXT_CACHE;
}

function daemonStatus(opencli) {
  const r = spawnSync(opencli, ["daemon", "status"], { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

// Minimal CDP-over-pipe client (fd3 write / fd4 read, NUL-delimited JSON).
function makePipe(chrome) {
  const wpipe = chrome.stdio[3], rpipe = chrome.stdio[4];
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map();
  rpipe.on("data", (d) => {
    buf = Buffer.concat([buf, d]); let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const chunk = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
      let m; try { m = JSON.parse(chunk); } catch { continue; }
      if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const _id = ++id; pending.set(_id, { resolve, reject });
    wpipe.write(JSON.stringify({ id: _id, method, params }) + "\0");
    setTimeout(() => { if (pending.has(_id)) { pending.delete(_id); reject(new Error("CDP timeout: " + method)); } }, 15000);
  });
  return { send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chromeBin = findChrome();
  const opencli = resolveOpencli();
  log("chrome:", chromeBin);
  log("profile:", PROFILE, "(persistent — warm it once and clearance/logins stick)");

  // 1. daemon up
  if (!/running/i.test(daemonStatus(opencli))) { log("starting opencli daemon…"); spawnSync(opencli, ["daemon", "restart"], { encoding: "utf8" }); }

  // 2. extension cached
  const extDir = await ensureExtension();
  mkdirSync(PROFILE, { recursive: true });

  // 3. launch Chrome with stealth flags + CDP pipe
  const flags = [
    `--user-data-dir=${PROFILE}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",     // required for Extensions.loadUnpacked over CDP
    "--disable-blink-features=AutomationControlled", // drop navigator.webdriver=true
    "--silent-debugger-extension-api",         // suppress the "extension is debugging this browser" banner/signal
    "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
    "--disable-features=Translate,InterestFeedContentSuggestions",
    "--lang=en-US", "--window-size=1280,800",
    START_URL,
  ];
  log("launching Chrome (stealth flags on)…");
  const chrome = spawn(chromeBin, flags, { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
  chrome.on("exit", (c) => { log("Chrome exited:", c); process.exit(0); });
  const { send } = makePipe(chrome);
  await sleep(1500);

  // 4. load extensions via CDP
  const loaded = [];
  try { const r = await send("Extensions.loadUnpacked", { path: extDir }); loaded.push("opencli:" + r.id); }
  catch (e) { die("loadUnpacked(opencli) failed: " + e.message); }
  if (USE_STEALTH) {
    try { const r = await send("Extensions.loadUnpacked", { path: STEALTH_EXT }); loaded.push("stealth:" + r.id); }
    catch (e) { log("WARN stealth extension load failed (continuing):", e.message); }
  }
  log("extensions loaded:", loaded.join(", "));

  // 5. wait for the bridge, then verify webdriver
  let connected = false;
  for (let i = 0; i < 20; i++) {
    if (/Extension: connected|Connectivity: connected/i.test(daemonStatus(opencli))) { connected = true; break; }
    await sleep(1000);
  }
  log(connected ? "✅ opencli bridge CONNECTED" : "⚠ bridge not reporting connected yet (try: opencli doctor)");

  if (USE_STEALTH) {
    const sess = "stealth-selfcheck";
    spawnSync(opencli, ["browser", sess, "open", "https://example.com/"], { encoding: "utf8", timeout: 30000 });
    const r = spawnSync(opencli, ["browser", sess, "eval", "navigator.webdriver"], { encoding: "utf8", timeout: 20000 });
    log("navigator.webdriver =", ((r.stdout || "").trim() || (r.stderr || "").trim()).slice(0, 120));
  }

  log("");
  log("Bridge is UP and will stay alive (Ctrl-C to stop). Drive it with, e.g.:");
  log("  opencli browser sky open https://www.skyscanner.net/ && opencli browser sky state");
  log("Generated forge servers using MCP_BROWSER_BACKEND=opencli will now use this browser.");
  process.stdin.resume(); // hold the pipe (and the loaded extensions) open
}

process.on("SIGINT", () => { log("shutting down."); process.exit(0); });
main().catch((e) => die(e.stack || String(e)));
