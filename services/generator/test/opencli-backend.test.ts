import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { chooseBrowserBackend, deriveDynamicSignals, emitOpenCliBrowsingRuntime } from "../src/opencli-backend.js";
import { generateServerSource, generateServer } from "../src/codegen.js";

// --- chooseBrowserBackend: PRECISION-FIRST routing (only bot-wall or explicit SPA shell route to opencli) ---

test("chooseBrowserBackend stays on playwright for a normal static/server-rendered page", () => {
  assert.equal(chooseBrowserBackend({ renderedWithJs: false, renderedTextLength: 5000, networkApiCount: 0 }), "playwright");
  assert.equal(chooseBrowserBackend({ renderedWithJs: true, renderedTextLength: 5000, networkApiCount: 2 }), "playwright");
});

test("chooseBrowserBackend picks opencli when an anti-bot wall was hit", () => {
  assert.equal(chooseBrowserBackend({ botWalled: true }), "opencli");
  assert.equal(chooseBrowserBackend({ botWalled: true, renderedWithJs: true, renderedTextLength: 9000 }), "opencli");
});

test("chooseBrowserBackend picks opencli for an explicit SPA shell with no API to wire", () => {
  assert.equal(chooseBrowserBackend({ spaShell: true, networkApiCount: 0 }), "opencli");
});

test("chooseBrowserBackend stays on playwright for a SPA shell that DID expose an API (wire HTTP tools instead)", () => {
  assert.equal(chooseBrowserBackend({ spaShell: true, networkApiCount: 3 }), "playwright");
});

test("chooseBrowserBackend does NOT route on loose thin-text alone (no false positives)", () => {
  // thin text but no confirmed bot-wall and no confirmed shell => stay on the standalone path.
  assert.equal(chooseBrowserBackend({ renderedWithJs: true, renderedTextLength: 40, networkApiCount: 0 }), "playwright");
});

test("chooseBrowserBackend defaults safely on missing signals", () => {
  assert.equal(chooseBrowserBackend({}), "playwright");
});

// --- deriveDynamicSignals: read the high-precision signals from a capture bundle + tools ---

test("deriveDynamicSignals: a normal server-rendered page is neither bot-walled nor a shell", () => {
  const html = "<html><body><h1>Welcome</h1><p>" + "real content ".repeat(80) + "</p></body></html>";
  const s = deriveDynamicSignals({ dom: { html }, meta: { renderedWithJs: false }, network: [] });
  assert.equal(s.botWalled, false);
  assert.equal(s.spaShell, false);
  assert.equal(chooseBrowserBackend(s), "playwright");
});

test("deriveDynamicSignals: a JS-only shell (noscript + app-root mount, tiny text, no captured API) routes to opencli", () => {
  const html = '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>';
  const s = deriveDynamicSignals({ dom: { html }, meta: { renderedWithJs: false }, network: [] });
  assert.equal(s.spaShell, true);
  assert.equal(s.networkApiCount, 0);
  assert.equal(chooseBrowserBackend(s), "opencli");
});

test("deriveDynamicSignals: a SPA shell that DID capture real XHR endpoints stays playwright (wire HTTP tools)", () => {
  const html = '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>';
  const s = deriveDynamicSignals({ dom: { html }, meta: { renderedWithJs: true }, network: [{}, {}] });
  assert.equal(s.spaShell, true);
  assert.equal(s.networkApiCount, 2);
  assert.equal(chooseBrowserBackend(s), "playwright");
});

test("deriveDynamicSignals: a Cloudflare/anti-bot challenge page is bot-walled", () => {
  const html = "<html><body><h1>Just a moment...</h1><p>Checking your browser before accessing.</p></body></html>";
  const s = deriveDynamicSignals({ dom: { html }, meta: { renderedWithJs: true }, network: [] });
  assert.equal(s.botWalled, true);
  assert.equal(chooseBrowserBackend(s), "opencli");
});

// --- emitOpenCliBrowsingRuntime: the emitted backend source ---

test("emitOpenCliBrowsingRuntime emits the class, factory, and verbatim opencli command mapping", () => {
  const src = emitOpenCliBrowsingRuntime("example-com", "playwright");
  assert.match(src, /class OpenCliBrowsing implements Browsing/);
  assert.match(src, /function createBrowsing/);
  assert.match(src, /"mcp-example-com"/); // default session name from the slug
  for (const cmd of ['"open"', '"state"', '"click"', '"type"', '"select"', '"keys"', '"extract"', '"back"']) {
    assert.ok(src.includes(cmd), `emitted backend missing opencli command ${cmd}`);
  }
});

test("emitOpenCliBrowsingRuntime bakes the chosen default backend, still overridable by env", () => {
  assert.match(emitOpenCliBrowsingRuntime("x", "opencli"), /DEFAULT_BROWSER_BACKEND: string = "opencli"/);
  assert.match(emitOpenCliBrowsingRuntime("x", "playwright"), /DEFAULT_BROWSER_BACKEND: string = "playwright"/);
  assert.match(emitOpenCliBrowsingRuntime("x", "playwright"), /process\.env\.MCP_BROWSER_BACKEND/);
  // graceful degradation surface: baked opencli default uses the degradable AutoBrowsing wrapper.
  assert.match(emitOpenCliBrowsingRuntime("x", "opencli"), /class AutoBrowsing implements Browsing/);
  assert.match(emitOpenCliBrowsingRuntime("x", "opencli"), /async healthcheck\(\)/);
});

// --- end-to-end wiring: the generated server source carries the backend + factory ---

test("generated server source wires createBrowsing and the opencli backend", () => {
  const src = generateServerSource({
    serverId: "88888888-8888-4888-8888-888888888888",
    version: 1,
    url: "https://www.skyscanner.net/",
    title: "Skyscanner",
    tools: [],
    browsing: true,
    dynamicBackend: "opencli",
  });
  assert.match(src, /class OpenCliBrowsing implements Browsing/);
  assert.match(src, /deps\.browsing \?\? createBrowsing\(deps\.browserExecutor\)/);
  assert.match(src, /DEFAULT_BROWSER_BACKEND: string = "opencli"/);
  const def = generateServerSource({
    serverId: "99999999-9999-4999-8999-999999999999",
    version: 1,
    url: "https://example.com/",
    title: "Example",
    tools: [],
    browsing: true,
  });
  assert.match(def, /DEFAULT_BROWSER_BACKEND: string = "playwright"/);
});

// --- behavioral: drive the emitted OpenCliBrowsing against a FAKE opencli binary that records its argv ---
// Mirrors codegen.test.ts's fake-codex pattern: no Chrome, no bridge - we only verify the backend constructs
// the correct `opencli browser <session> <cmd>` invocations and passes `state` through verbatim as the snapshot.

const packageRoot = fileURLToPath(new URL("../../", import.meta.url)); // services/generator/
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function compileServer(dir: string, serverTs: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/server.ts`, serverTs);
  writeFileSync(
    `${dir}/tsconfig.gen.json`,
    JSON.stringify({
      extends: "../../../tsconfig.base.json",
      compilerOptions: { rootDir: ".", outDir: "./out", declaration: false, declarationMap: false, sourceMap: false, types: ["node"] },
      include: ["server.ts"],
    }),
  );
  const tsc = `${repoRoot}node_modules/.bin/tsc`;
  const res = spawnSync(tsc, ["-p", `${dir}/tsconfig.gen.json`], { encoding: "utf8" });
  assert.equal(res.status, 0, `tsc failed:\n${res.stdout}\n${res.stderr}`);
  return `${dir}/out/server.js`;
}

function writeFakeOpencli(path: string, logPath: string, exitCode: number): void {
  // $1=browser $2=<session> $3=<cmd>. Log the full argv; for `state` print a recognizable snapshot; exit as told.
  const body =
    `#!/usr/bin/env bash\n` +
    `echo "$@" >> ${JSON.stringify(logPath)}\n` +
    `if [ "$3" = "state" ]; then echo "STATE:: [1] Search button"; fi\n` +
    `if [ ${exitCode} -ne 0 ]; then echo "boom" >&2; fi\n` +
    `exit ${exitCode}\n`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("OpenCliBrowsing issues correct opencli commands and passes `state` through as the snapshot", async (t) => {
  if (platform() === "win32") { t.skip("fake opencli is a POSIX shell script"); return; }
  const genDir = `${packageRoot}.gen-test-opencli`;
  const serverTs = generateServer({
    serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: 1,
    url: "https://example.com/",
    title: "Example",
    tools: [],
    browsing: true,
  }).files.find((f) => f.path === "server.ts")!.content;
  const jsPath = compileServer(genDir, serverTs);

  const fakeBin = `${genDir}/fake-opencli`;
  const log = `${genDir}/argv.log`;
  writeFakeOpencli(fakeBin, log, 0);

  const prev = {
    bin: process.env.MCP_OPENCLI_BIN, sess: process.env.MCP_OPENCLI_SESSION, backend: process.env.MCP_BROWSER_BACKEND, allow: process.env.MCP_ALLOW_PRIVATE_HOSTS,
  };
  // Module-level OPENCLI_BIN/SESSION are read at import time, so set them BEFORE importing the compiled server.
  process.env.MCP_OPENCLI_BIN = fakeBin;
  process.env.MCP_OPENCLI_SESSION = "testsess";
  process.env.MCP_BROWSER_BACKEND = "opencli";
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";

  try {
    const mod = await import(jsPath);
    const server = mod.createServer(); // no injected backend -> createBrowsing() picks OpenCliBrowsing via env
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "opencli-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/x" } });
      assert.equal(nav.isError, false, nav.content?.[0]?.text);
      assert.match(nav.content[0].text, /STATE::/, "snapshot should be opencli `state` output, verbatim");

      const click: any = await client.callTool({ name: "browser_click", arguments: { ref: "1" } });
      assert.match(click.content[0].text, /STATE::/);

      const typed: any = await client.callTool({ name: "browser_type", arguments: { ref: "1", text: "hello", submit: true } });
      assert.equal(typed.isError, false, typed.content?.[0]?.text);

      const argv = readFileSync(log, "utf8");
      assert.match(argv, /browser testsess open https:\/\/example\.com\/x/, "navigate -> open <url> on the named session");
      assert.match(argv, /browser testsess state/, "snapshot -> state");
      assert.match(argv, /browser testsess click 1/, "click(ref) -> click <ref>");
      assert.match(argv, /browser testsess type 1 hello/, "type(ref,text) -> type <ref> <text>");
      assert.match(argv, /browser testsess keys Enter/, "submit -> keys Enter");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (prev.bin === undefined) delete process.env.MCP_OPENCLI_BIN; else process.env.MCP_OPENCLI_BIN = prev.bin;
    if (prev.sess === undefined) delete process.env.MCP_OPENCLI_SESSION; else process.env.MCP_OPENCLI_SESSION = prev.sess;
    if (prev.backend === undefined) delete process.env.MCP_BROWSER_BACKEND; else process.env.MCP_BROWSER_BACKEND = prev.backend;
    if (prev.allow === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = prev.allow;
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("OpenCliBrowsing surfaces a failed opencli command as a tool error with the bridge hint", async (t) => {
  if (platform() === "win32") { t.skip("fake opencli is a POSIX shell script"); return; }
  const genDir = `${packageRoot}.gen-test-opencli-err`;
  const serverTs = generateServer({
    serverId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    version: 1,
    url: "https://example.com/",
    title: "Example",
    tools: [],
    browsing: true,
  }).files.find((f) => f.path === "server.ts")!.content;
  const jsPath = compileServer(genDir, serverTs);

  const fakeBin = `${genDir}/fake-opencli`;
  const log = `${genDir}/argv.log`;
  writeFakeOpencli(fakeBin, log, 1); // always fails

  const prev = { bin: process.env.MCP_OPENCLI_BIN, backend: process.env.MCP_BROWSER_BACKEND, allow: process.env.MCP_ALLOW_PRIVATE_HOSTS };
  process.env.MCP_OPENCLI_BIN = fakeBin;
  process.env.MCP_BROWSER_BACKEND = "opencli";
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    const mod = await import(jsPath);
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "opencli-err-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/x" } });
      assert.equal(nav.isError, true, "a non-zero opencli exit must surface as a tool error");
      assert.match(nav.content[0].text, /opencli browser open failed/);
      assert.match(nav.content[0].text, /opencli doctor/, "error includes the bridge-connectivity hint");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (prev.bin === undefined) delete process.env.MCP_OPENCLI_BIN; else process.env.MCP_OPENCLI_BIN = prev.bin;
    if (prev.backend === undefined) delete process.env.MCP_BROWSER_BACKEND; else process.env.MCP_BROWSER_BACKEND = prev.backend;
    if (prev.allow === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = prev.allow;
    rmSync(genDir, { recursive: true, force: true });
  }
});

// A fake opencli whose bridge is DOWN: `doctor` reports not-connected and every browser command fails. Used to
// prove the strict-vs-degradable contrast.
function writeDeadOpencli(path: string): void {
  const body =
    `#!/usr/bin/env bash\n` +
    `if [ "$1" = "doctor" ]; then echo "[FAIL] Connectivity: failed (Browser Bridge extension not connected)"; exit 0; fi\n` +
    `echo "bridge down" >&2\n` +
    `exit 1\n`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function opencliBakedServer(genDir: string): string {
  const serverTs = generateServer({
    serverId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    version: 1, url: "https://example.com/", title: "Example", tools: [], browsing: true,
    dynamicBackend: "opencli", // BAKED default (auto-detected), not an explicit env choice
  }).files.find((f) => f.path === "server.ts")!.content;
  return compileServer(genDir, serverTs);
}

test("baked opencli default DEGRADES to Playwright when the bridge is unreachable (no hard fail)", async (t) => {
  if (platform() === "win32") { t.skip("fake opencli is a POSIX shell script"); return; }
  const genDir = `${packageRoot}.gen-test-degrade`;
  const jsPath = opencliBakedServer(genDir);
  const fakeBin = `${genDir}/dead-opencli`;
  writeDeadOpencli(fakeBin);

  const prev = { bin: process.env.MCP_OPENCLI_BIN, backend: process.env.MCP_BROWSER_BACKEND, path: process.env.MCP_BROWSER_PATH, allow: process.env.MCP_ALLOW_PRIVATE_HOSTS };
  process.env.MCP_OPENCLI_BIN = fakeBin;
  delete process.env.MCP_BROWSER_BACKEND;          // no explicit choice => baked default => AutoBrowsing
  process.env.MCP_BROWSER_PATH = `${genDir}/no-such-chrome`; // make the Playwright fallback fail FAST (no real launch)
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    const mod = await import(jsPath);
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "degrade-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
      const text = nav.content?.[0]?.text || "";
      // The KEY assertion: a baked default must NOT surface the opencli bridge error - it fell back to Playwright.
      assert.doesNotMatch(text, /opencli browser (open|state) failed/, "baked default must degrade, not hard-fail on opencli");
    } finally {
      await (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing?.close?.();
      await client.close(); await server.close();
    }
  } finally {
    if (prev.bin === undefined) delete process.env.MCP_OPENCLI_BIN; else process.env.MCP_OPENCLI_BIN = prev.bin;
    if (prev.backend === undefined) delete process.env.MCP_BROWSER_BACKEND; else process.env.MCP_BROWSER_BACKEND = prev.backend;
    if (prev.path === undefined) delete process.env.MCP_BROWSER_PATH; else process.env.MCP_BROWSER_PATH = prev.path;
    if (prev.allow === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = prev.allow;
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("explicit MCP_BROWSER_BACKEND=opencli is STRICT: surfaces the bridge error when unreachable", async (t) => {
  if (platform() === "win32") { t.skip("fake opencli is a POSIX shell script"); return; }
  const genDir = `${packageRoot}.gen-test-strict`;
  const jsPath = opencliBakedServer(genDir);
  const fakeBin = `${genDir}/dead-opencli`;
  writeDeadOpencli(fakeBin);

  const prev = { bin: process.env.MCP_OPENCLI_BIN, backend: process.env.MCP_BROWSER_BACKEND, allow: process.env.MCP_ALLOW_PRIVATE_HOSTS };
  process.env.MCP_OPENCLI_BIN = fakeBin;
  process.env.MCP_BROWSER_BACKEND = "opencli"; // EXPLICIT => strict, no fallback
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    const mod = await import(jsPath + "?strict");
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "strict-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
      const text = nav.content?.[0]?.text || "";
      assert.match(text, /opencli browser open failed/, "explicit opencli must surface the bridge error");
      assert.match(text, /opencli doctor/, "error includes the actionable bridge hint");
    } finally {
      await client.close(); await server.close();
    }
  } finally {
    if (prev.bin === undefined) delete process.env.MCP_OPENCLI_BIN; else process.env.MCP_OPENCLI_BIN = prev.bin;
    if (prev.backend === undefined) delete process.env.MCP_BROWSER_BACKEND; else process.env.MCP_BROWSER_BACKEND = prev.backend;
    if (prev.allow === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = prev.allow;
    rmSync(genDir, { recursive: true, force: true });
  }
});

// A fake opencli whose bridge IS connected: `doctor` reports connected, `state` prints a snapshot, all else
// logs argv + succeeds. Exercises the AutoBrowsing SUCCESS branch (healthcheck passes -> drive opencli).
function writeConnectedOpencli(path: string, logPath: string): void {
  const body =
    `#!/usr/bin/env bash\n` +
    `if [ "$1" = "doctor" ]; then echo "[OK] Extension: connected (v1.0.18)"; echo "[OK] Connectivity: connected in 0.1s"; exit 0; fi\n` +
    `echo "$@" >> ${JSON.stringify(logPath)}\n` +
    `if [ "$3" = "state" ]; then echo "STATE:: [1] Search"; fi\n` +
    `exit 0\n`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("baked opencli default with a CONNECTED bridge drives opencli (AutoBrowsing success path)", async (t) => {
  if (platform() === "win32") { t.skip("fake opencli is a POSIX shell script"); return; }
  const genDir = `${packageRoot}.gen-test-auto-ok`;
  const jsPath = opencliBakedServer(genDir);
  const fakeBin = `${genDir}/connected-opencli`;
  const log = `${genDir}/argv.log`;
  writeConnectedOpencli(fakeBin, log);

  const prev = { bin: process.env.MCP_OPENCLI_BIN, backend: process.env.MCP_BROWSER_BACKEND, sess: process.env.MCP_OPENCLI_SESSION, allow: process.env.MCP_ALLOW_PRIVATE_HOSTS };
  process.env.MCP_OPENCLI_BIN = fakeBin;
  process.env.MCP_OPENCLI_SESSION = "autosess";
  delete process.env.MCP_BROWSER_BACKEND; // no explicit choice => baked default => AutoBrowsing => healthcheck passes
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    const mod = await import(jsPath + "?autook");
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "auto-ok-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/x" } });
      assert.equal(nav.isError, false, nav.content?.[0]?.text);
      assert.match(nav.content[0].text, /STATE::/, "snapshot is the opencli `state` output (drove opencli, not playwright)");
      const argv = readFileSync(log, "utf8");
      assert.match(argv, /browser autosess open https:\/\/example\.com\/x/, "AutoBrowsing delegated to opencli with the right argv");
      assert.match(argv, /browser autosess state/);
    } finally {
      await (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing?.close?.();
      await client.close(); await server.close();
    }
  } finally {
    if (prev.bin === undefined) delete process.env.MCP_OPENCLI_BIN; else process.env.MCP_OPENCLI_BIN = prev.bin;
    if (prev.backend === undefined) delete process.env.MCP_BROWSER_BACKEND; else process.env.MCP_BROWSER_BACKEND = prev.backend;
    if (prev.sess === undefined) delete process.env.MCP_OPENCLI_SESSION; else process.env.MCP_OPENCLI_SESSION = prev.sess;
    if (prev.allow === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = prev.allow;
    rmSync(genDir, { recursive: true, force: true });
  }
});
