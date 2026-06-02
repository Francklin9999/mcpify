import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { generateServer } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const packageRoot = fileURLToPath(new URL("../../", import.meta.url)); // services/generator/
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const genDir = `${packageRoot}.gen-test`;

const validTool = repoFixture("tool-definitions/sample-http-tool.json");

// A second http tool exercising the query / header / body paramMapping branches (not just path).
const searchTool = {
  name: "search_products",
  description: "Search products",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" }, limit: { type: "number" }, payload: { type: "string" }, xtoken: { type: "string" } },
    required: ["q"],
  },
  execution: {
    kind: "http",
    request: {
      method: "POST",
      urlPattern: "/api/search",
      rawUrl: "https://example.com/api/search",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: {
      q: { in: "query", key: "q" },
      limit: { in: "query", key: "limit" },
      payload: { in: "body", key: "data" },
      xtoken: { in: "header", key: "x-token" },
    },
  },
  confidence: 0.8,
};

const browserTool = {
  name: "get_product_details",
  description: "Open a product page in a browser and return structured JSON details.",
  inputSchema: {
    type: "object",
    properties: { asin: { type: "string" } },
    required: ["asin"],
  },
  execution: {
    kind: "browser",
    steps: [
      { action: "navigate", value: "https://example.com/dp/{{asin}}" },
      { action: "waitFor", target: { role: "page", selector: "body" } },
      { action: "extract", value: "json:product" },
    ],
  },
  confidence: 0.86,
};

const artifact = generateServer({
  serverId: "44444444-4444-4444-8444-444444444444",
  version: 1,
  url: "https://example.com/products",
  title: "Example",
  tools: [validTool, searchTool, browserTool],
});

test("artifact ships an installable manifest pinning the verified dep ranges", () => {
  const pkg = JSON.parse(artifact.files.find((f) => f.path === "package.json")!.content);
  assert.equal(pkg.type, "module");
  assert.ok(pkg.scripts.build && pkg.scripts.start);
  assert.match(pkg.dependencies.zod, /3\.25|4\.0/); // MCP SDK requires zod >=3.25
  assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"].startsWith("^1"));
  assert.ok(artifact.files.some((f) => f.path === "tsconfig.json"));
});

test("artifact ships one-step installers (install.sh/install.ps1) + a config helper", () => {
  const sh = artifact.files.find((f) => f.path === "install.sh")!.content;
  const ps1 = artifact.files.find((f) => f.path === "install.ps1")!.content;
  const helper = artifact.files.find((f) => f.path === "mcp-register.mjs")!.content;
  assert.ok(sh && ps1 && helper, "installers + helper are emitted");

  // install.sh: builds, resolves an absolute node path, defaults to Claude Code user MCPs.
  assert.match(sh, /^#!\/usr\/bin\/env bash/);
  assert.match(sh, /npm run build/);
  assert.match(sh, /command -v node/);
  assert.match(sh, /CLAUDE_CODE_CONFIG/);
  assert.match(sh, /MCP_TARGET=desktop/);
  assert.match(sh, /mcp-register\.mjs/);
  // install.ps1: PowerShell, Claude Code user config, same helper.
  assert.match(ps1, /\$PSScriptRoot/);
  assert.match(ps1, /CLAUDE_CODE_CONFIG/);
  assert.match(ps1, /MCP_TARGET/);
  assert.match(ps1, /mcp-register\.mjs/);
  // The server slug appears in both so the registered entry is named per-site.
  assert.match(sh, /SERVER_NAME="example-com"/);
  assert.match(ps1, /\$ServerName = "example-com"/);
});

// The helper must be idempotent, preserve existing user MCPs, remove duplicate project-scoped entries,
// create the file/dir when absent, and write an absolute command/args. Run the real helper to prove it.
test("mcp-register.mjs registers Claude Code user MCPs and cleans duplicate scopes", () => {
  rmSync(genDir, { recursive: true, force: true });
  mkdirSync(genDir, { recursive: true });
  const helper = artifact.files.find((f) => f.path === "mcp-register.mjs")!.content;
  const helperPath = `${genDir}/mcp-register.mjs`;
  writeFileSync(helperPath, helper);

  const cfgPath = `${genDir}/nested/dir/.claude.json`;
  const desktopPath = `${genDir}/desktop/claude_desktop_config.json`;
  mkdirSync(`${genDir}/nested/dir`, { recursive: true });
  mkdirSync(`${genDir}/desktop`, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      mcpServers: { existing: { type: "stdio", command: "node", args: ["/x/other.js"], env: {} } },
      projects: {
        "/tmp/project": {
          mcpServers: {
            "example-com": { type: "stdio", command: "old-node", args: ["/old/server.js"], env: {} },
            keep: { type: "stdio", command: "node", args: ["/keep/server.js"], env: {} },
          },
        },
      },
    }),
  );
  writeFileSync(
    desktopPath,
    JSON.stringify({ mcpServers: { "example-com": { command: "node", args: ["/old/server.js"] }, keep: { command: "node" } } }),
  );

  const res = spawnSync(process.execPath, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_REG_MODE: "claude-code-user",
      MCP_REG_CLAUDE_CODE_CONFIG: cfgPath,
      MCP_REG_CLEAN_CONFIGS: desktopPath,
      MCP_REG_NAME: "example-com",
      MCP_REG_NODE: "/usr/local/bin/node",
      MCP_REG_JS: `${genDir}/server.js`,
    },
  });
  assert.equal(res.status, 0, `helper failed:\n${res.stdout}\n${res.stderr}`);

  const merged = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepEqual(
    merged.mcpServers.existing,
    { type: "stdio", command: "node", args: ["/x/other.js"], env: {} },
    "existing entry preserved",
  );
  assert.equal(merged.mcpServers["example-com"].type, "stdio");
  assert.equal(merged.mcpServers["example-com"].command, "/usr/local/bin/node");
  assert.deepEqual(merged.mcpServers["example-com"].args, [`${genDir}/server.js`]);
  assert.equal(merged.projects["/tmp/project"].mcpServers["example-com"], undefined);
  assert.ok(merged.projects["/tmp/project"].mcpServers.keep, "other project MCPs survive cleanup");

  const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
  assert.equal(desktop.mcpServers["example-com"], undefined);
  assert.ok(desktop.mcpServers.keep, "other desktop MCPs survive cleanup");

  // First-time install: no config file at all -> helper creates it (+ parent dirs).
  const freshPath = `${genDir}/fresh/.claude.json`;
  const res2 = spawnSync(process.execPath, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_REG_MODE: "claude-code-user",
      MCP_REG_CLAUDE_CODE_CONFIG: freshPath,
      MCP_REG_NAME: "example-com",
      MCP_REG_NODE: "node",
      MCP_REG_JS: "/s.js",
    },
  });
  assert.equal(res2.status, 0, `helper (fresh) failed:\n${res2.stdout}\n${res2.stderr}`);
  assert.ok(existsSync(freshPath), "helper created the config file from scratch");
  assert.ok(JSON.parse(readFileSync(freshPath, "utf8")).mcpServers["example-com"]);
});

test("mcp-register.mjs keeps legacy Claude Desktop mode available", () => {
  rmSync(genDir, { recursive: true, force: true });
  mkdirSync(genDir, { recursive: true });
  const helper = artifact.files.find((f) => f.path === "mcp-register.mjs")!.content;
  const helperPath = `${genDir}/mcp-register.mjs`;
  writeFileSync(helperPath, helper);

  const cfgPath = `${genDir}/desktop/config.json`;
  const res = spawnSync(process.execPath, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_REG_MODE: "desktop",
      MCP_REG_CONFIG: cfgPath,
      MCP_REG_NAME: "example-com",
      MCP_REG_NODE: "/usr/local/bin/node",
      MCP_REG_JS: `${genDir}/server.js`,
    },
  });
  assert.equal(res.status, 0, `helper failed:\n${res.stdout}\n${res.stderr}`);

  const merged = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(merged.mcpServers["example-com"].command, "/usr/local/bin/node");
  assert.deepEqual(merged.mcpServers["example-com"].args, [`${genDir}/server.js`]);
});

// Gate A: the generated server.ts TYPE-CHECKS against the real @modelcontextprotocol/sdk
// (a clean tsc emit catches a hallucinated SDK API - wrong registerTool config, bad CallToolResult shape).
test("generated server.ts compiles against the real MCP SDK", () => {
  rmSync(genDir, { recursive: true, force: true });
  mkdirSync(genDir, { recursive: true });
  const serverTs = artifact.files.find((f) => f.path === "server.ts")!.content;
  writeFileSync(`${genDir}/server.ts`, serverTs);
  writeFileSync(
    `${genDir}/tsconfig.gen.json`,
    JSON.stringify({
      extends: "../../../tsconfig.base.json",
      compilerOptions: {
        rootDir: ".",
        outDir: "./out",
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        types: ["node"],
      },
      include: ["server.ts"],
    }),
  );
  const tsc = `${repoRoot}node_modules/.bin/tsc`;
  const res = spawnSync(tsc, ["-p", `${genDir}/tsconfig.gen.json`], { encoding: "utf8" });
  assert.equal(res.status, 0, `tsc failed:\n${res.stdout}\n${res.stderr}`);
});

// Gate B: the generated server ACTS - register tools and execute an http tool over a real client
test("generated server registers tools and executes an http call mapped from paramMapping", async () => {
  // Import the emitted JS (compiled in Gate A). The main-guard does NOT connect stdio on import.
  const mod = await import(`${genDir}/out/server.js`);
  const server = mod.createServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);

  // Tools are actually registered and discoverable: the 3 inferred tools + the fixed browsing toolkit
  // (emitted because a browser tool is present). The toolkit lets an LLM drive the page turn-by-turn.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const inferred of ["get_product", "get_product_details", "search_products"]) {
    assert.ok(names.includes(inferred), `missing inferred tool ${inferred}`);
  }
  for (const kit of [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_select_option",
    "browser_back",
    "browser_read_page",
    "browser_extract",
  ]) {
    assert.ok(names.includes(kit), `missing browsing toolkit tool ${kit}`);
  }
  assert.equal(tools.length, 12);

  const realFetch = globalThis.fetch;
  let captured: { url: string; method?: string; headers?: any; body?: any } | undefined;
  let nextBody = "OK-BODY";
  let nextCtype = "application/json";
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), method: init?.method, headers: init?.headers, body: init?.body };
    return { ok: true, status: 200, headers: { get: () => nextCtype }, text: async () => nextBody } as any;
  }) as typeof fetch;

  try {
    // path param: id -> /api/products/{id}
    const r1: any = await client.callTool({ name: "get_product", arguments: { id: "42" } });
    assert.equal(captured?.url, "https://example.com/api/products/42");
    assert.equal(captured?.method, "GET");
    assert.equal(r1.content[0].text, "OK-BODY");
    assert.notEqual(r1.isError, true);

    // query + header + body branches
    await client.callTool({
      name: "search_products",
      arguments: { q: "shoes", limit: 5, payload: "hi", xtoken: "tok" },
    });
    assert.equal(captured?.method, "POST");
    assert.ok(captured!.url.startsWith("https://example.com/api/search?"));
    assert.match(captured!.url, /q=shoes/);
    assert.match(captured!.url, /limit=5/);
    assert.equal(captured!.headers["x-token"], "tok");
    assert.equal(captured!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(captured!.body), { data: "hi" });

    // inputSchema is actually WIRED (guards the `as unknown as` register cast): a missing required
    // arg must be rejected, not silently passed through to fetch.
    captured = undefined;
    let rejected = false;
    try {
      const bad: any = await client.callTool({ name: "get_product", arguments: {} });
      rejected = bad?.isError === true;
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "missing required arg should be rejected by inputSchema validation");
    assert.equal(captured, undefined, "rejected call must not reach fetch");

    // HTML responses are returned as READABLE TEXT (tags stripped), not raw markup.
    nextCtype = "text/html; charset=utf-8";
    nextBody = "<html><head><title>T</title><style>.x{}</style></head><body><h1>Hello</h1><script>var a=1<2;</script><p>World &amp; more</p></body></html>";
    const html: any = await client.callTool({ name: "get_product", arguments: { id: "1" } });
    const out = html.content[0].text;
    assert.ok(!out.includes("<"), "HTML tags must be stripped");
    assert.ok(!out.includes("var a=1"), "script contents must be removed");
    assert.match(out, /Hello/);
    assert.match(out, /World & more/); // entity decoded

    const browserMod = await import(`${genDir}/out/server.js`);
    const browserServer = browserMod.createServer({
      browserExecutor: async (_spec: unknown, args: Record<string, unknown>) => ({ asin: args.asin, title: "Example Product" }),
    });
    const [browserClientTransport, browserServerTransport] = InMemoryTransport.createLinkedPair();
    await browserServer.connect(browserServerTransport);
    const browserClient = new Client({ name: "browser-test", version: "1.0.0" });
    await browserClient.connect(browserClientTransport);
    const browserResult: any = await browserClient.callTool({ name: "get_product_details", arguments: { asin: "B000TEST" } });
    assert.match(browserResult.content[0].text, /Example Product/);
    await browserClient.close();
    await browserServer.close();
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
    await server.close();
    rmSync(genDir, { recursive: true, force: true });
  }
});

// Shared helper: write a server.ts + tsconfig, compile with the real tsc, return its emitted JS path
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

// The shared-session GUARANTEE: the browsing toolkit routes every tool call to ONE persistent session,
// so state set by one tool call (e.g. add-to-cart) is visible to a later, separate tool call (view cart).
// This is the whole reason multi-step flows work; it's proven here with an injected fake backend (no
// browser needed) so the WIRING is verified deterministically even where Chromium is unavailable.
test("browsing toolkit shares one persistent session across separate tool calls", async () => {
  const genDir2 = `${packageRoot}.gen-test-session`;
  const serverTs = generateServer({
    serverId: "55555555-5555-4555-8555-555555555555",
    version: 1,
    url: "https://shop.example.com/",
    title: "Shop",
    tools: [validTool],
    browsing: true,
  }).files.find((f) => f.path === "server.ts")!.content;

  const jsPath = compileServer(genDir2, serverTs);
  try {
    const mod = await import(jsPath);

    // A fake persistent backend: an in-memory "cart" that only browser_click mutates. If the toolkit
    // wired each tool to its OWN backend, the snapshot after a click would still read cart=0.
    let cart = 0;
    let lastPage = "home";
    const fakeBrowsing = {
      async runSteps() { return "steps"; },
      async navigate(url: string) { lastPage = url; return `PAGE nav ${url}\ncart=${cart}`; },
      async snapshot() { return `PAGE ${lastPage}\ncart=${cart}`; },
      async click(ref: string) { if (ref === "addcart") cart++; lastPage = "after-click"; return `PAGE after-click\ncart=${cart}`; },
      async type(_ref: string, text: string, submit?: boolean) { return `typed ${text} submit=${submit === true}`; },
      async pressKey(key: string, ref?: string) { return `pressed ${key} ref=${ref || ""}`; },
      async selectOption() { return "selected"; },
      async back() { return "back"; },
      async read() { return "readable text"; },
      async extract(mode: string) { return { mode }; },
    };

    const server = mod.createServer({ browsing: fakeBrowsing });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "session-test", version: "1.0.0" });
    await client.connect(ct);

    try {
      // before: cart is empty
      const s0: any = await client.callTool({ name: "browser_snapshot", arguments: {} });
      assert.match(s0.content[0].text, /cart=0/);

      // a SEPARATE tool call mutates shared state
      const c1: any = await client.callTool({ name: "browser_click", arguments: { ref: "addcart" } });
      assert.match(c1.content[0].text, /cart=1/);

      // a LATER, separate snapshot call sees the persisted state - proves one shared session
      const s1: any = await client.callTool({ name: "browser_snapshot", arguments: {} });
      assert.match(s1.content[0].text, /cart=1/);

      // submit flag and ref both flow through
      const t1: any = await client.callTool({ name: "browser_type", arguments: { ref: "e1", text: "laptop", submit: true } });
      assert.match(t1.content[0].text, /typed laptop submit=true/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(genDir2, { recursive: true, force: true });
  }
});

// Real-mechanism test: the actual snapshot->ref->click loop driven by REAL Chromium against a local HTML
// fixture (no network). A fake backend can't catch a broken data-__mcp_ref scheme; this can. Skips LOUDLY
// when playwright/chromium isn't installed (mirrors the repo's tier-2 "skip, don't fake" stance).
test("real browser session: snapshot assigns refs and click-by-ref mutates the live page", async (t) => {
  let chromiumPath: string | undefined;
  let pw: any;
  try {
    // Indirect import so tsc doesn't try to resolve "playwright" at build time (it's an optional dev dep).
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    pw = await dynamicImport("playwright");
    chromiumPath = pw.chromium.executablePath?.();
  } catch {
    /* playwright not installed */
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    t.skip("playwright + chromium not installed - run `npm i -D playwright -w @mcp/generator && npx playwright install chromium` to exercise the real session");
    return;
  }
  try {
    const browser = await pw.chromium.launch({ executablePath: chromiumPath, chromiumSandbox: false });
    await browser.close();
  } catch (err) {
    t.skip(`playwright chromium launch is unavailable in this environment: ${String(err)}`);
    return;
  }

  const genDir3 = `${packageRoot}.gen-test-real`;
  const fixtureHtml = `<!doctype html><html><head><title>Fixture Shop</title></head><body>
    <h1>Fixture Shop</h1>
    <button id="add" type="button">Add to cart</button>
    <div id="cart">cart: 0</div>
    <script>
      var n = 0;
      document.getElementById('add').addEventListener('click', function () {
        n++; document.getElementById('cart').textContent = 'cart: ' + n;
      });
    </script>
  </body></html>`;
  const fixturePath = `${genDir3}/fixture.html`;
  const fixtureUrl = pathToFileURL(fixturePath).href;

  const serverTs = generateServer({
    serverId: "66666666-6666-4666-8666-666666666666",
    version: 1,
    url: fixtureUrl,
    title: "Fixture Shop",
    tools: [],
    browsing: true,
  }).files.find((f) => f.path === "server.ts")!.content;
  // compileServer wipes + recreates genDir3, so write the fixture file AFTER it (the URL is deterministic).
  const jsPath = compileServer(genDir3, serverTs);
  writeFileSync(fixturePath, fixtureHtml);

  try {
    const mod = await import(jsPath);
    const server = mod.createServer(); // REAL PlaywrightBrowsing, no injection
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "real-browser-test", version: "1.0.0" });
    await client.connect(ct);

    try {
      // 1. snapshot the homepage: the button must appear with a [ref], cart starts at 0
      const snap: any = await client.callTool({ name: "browser_snapshot", arguments: {} });
      const snapText: string = snap.content[0].text;
      assert.match(snapText, /Add to cart/);
      assert.match(snapText, /cart: 0/);
      const ref = snapText.match(/\[(e\d+)\][^\n]*Add to cart/)?.[1];
      assert.ok(ref, `snapshot did not assign a ref to the button:\n${snapText}`);

      // 2. click BY REF - the page's JS must run and mutate the DOM; click returns a fresh snapshot
      const clicked: any = await client.callTool({ name: "browser_click", arguments: { ref } });
      assert.match(clicked.content[0].text, /cart: 1/, "click-by-ref did not mutate the live page");

      // 3. a stale/bogus ref fails clearly instead of throwing
      const stale: any = await client.callTool({ name: "browser_click", arguments: { ref: "e999" } });
      assert.match(stale.content[0].text, /browser_snapshot/);
    } finally {
      // Release Chromium - without this the launched browser is an open handle and node --test never exits.
      await (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing?.close?.();
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(genDir3, { recursive: true, force: true });
  }
});

// Regression: json:listing extraction must honor the inference's explicit card selector and return ONE
// record per card - on ANY listing site, not just product-URL pages. (Before the fix, the extractor used a
// hardcoded /dp//product/ URL heuristic and returned [] on e.g. quotes/articles.) REAL Chromium, local file.
test("real browser session: json:listing extract honors the card selector (one record per card)", async (t) => {
  let chromiumPath: string | undefined;
  let pw: any;
  try {
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    pw = await dynamicImport("playwright");
    chromiumPath = pw.chromium.executablePath?.();
  } catch {
    /* playwright not installed */
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    t.skip("playwright + chromium not installed - skipping the real listing-extraction test");
    return;
  }
  try {
    const browser = await pw.chromium.launch({ executablePath: chromiumPath, chromiumSandbox: false });
    await browser.close();
  } catch (err) {
    t.skip(`playwright chromium launch is unavailable in this environment: ${String(err)}`);
    return;
  }

  const genDir4 = `${packageRoot}.gen-test-listing`;
  // A non-ecommerce listing (no /dp//product/ URLs) - the old heuristic would return [] here.
  const fixtureHtml = `<!doctype html><html><head><title>Quotes Fixture</title></head><body>
    <h1>Quotes</h1>
    <div class="quote"><span class="text">First quote here</span><small class="author">Ada</small></div>
    <div class="quote"><span class="text">Second quote here</span><small class="author">Alan</small></div>
    <div class="quote"><span class="text">Third quote here</span><small class="author">Grace</small></div>
  </body></html>`;
  const fixturePath = `${genDir4}/fixture.html`;
  const fixtureUrl = pathToFileURL(fixturePath).href;

  const listTool = {
    name: "list_quotes",
    description: "List the quotes on the page.",
    inputSchema: { type: "object", properties: {} },
    execution: {
      kind: "browser" as const,
      steps: [
        { action: "navigate" as const, value: fixtureUrl },
        { action: "waitFor" as const, target: { role: "list", selector: "div.quote" } },
        { action: "extract" as const, target: { role: "list", selector: "div.quote", fallbackSelectors: [".quote"] }, value: "json:listing" },
      ],
    },
    confidence: 0.8,
  };
  const serverTs = generateServer({
    serverId: "77777777-7777-4777-8777-777777777777",
    version: 1,
    url: fixtureUrl,
    title: "Quotes Fixture",
    tools: [listTool as any],
  }).files.find((f) => f.path === "server.ts")!.content;
  const jsPath = compileServer(genDir4, serverTs);
  writeFileSync(fixturePath, fixtureHtml);

  try {
    const mod = await import(jsPath);
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "listing-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const res: any = await client.callTool({ name: "list_quotes", arguments: {} });
      assert.equal(res.isError, false, `list_quotes errored: ${res.content?.[0]?.text}`);
      const records = JSON.parse(res.content[0].text);
      assert.ok(Array.isArray(records), "extract should return a JSON array");
      assert.equal(records.length, 3, `expected one record per card, got ${records.length}: ${res.content[0].text}`);
      const joined = records.map((r: any) => r.text || "").join(" | ");
      assert.match(joined, /First quote here/);
      assert.match(joined, /Second quote here/);
      assert.match(joined, /Third quote here/);
    } finally {
      await (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing?.close?.();
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(genDir4, { recursive: true, force: true });
  }
});

// Pagination interpolation: a single-brace {page} template (inference is inconsistent about braces) must be
// filled, and calling the tool with NO page must stay on the opening page instead of navigating to a 404.
test("real browser session: single-brace {page} fills, and missing page stays on the current listing", async (t) => {
  let chromiumPath: string | undefined;
  let pw: any;
  try {
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    pw = await dynamicImport("playwright");
    chromiumPath = pw.chromium.executablePath?.();
  } catch {
    /* playwright not installed */
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    t.skip("playwright + chromium not installed - skipping the real pagination test");
    return;
  }
  try {
    const browser = await pw.chromium.launch({ executablePath: chromiumPath, chromiumSandbox: false });
    await browser.close();
  } catch (err) {
    t.skip(`playwright chromium launch is unavailable in this environment: ${String(err)}`);
    return;
  }

  const genDir5 = `${packageRoot}.gen-test-paginate`;
  rmSync(genDir5, { recursive: true, force: true });
  mkdirSync(genDir5, { recursive: true });
  const card = (text: string) => `<div class="card">${text}</div>`;
  writeFileSync(`${genDir5}/page-1.html`, `<!doctype html><title>p1</title><body>${card("ALPHA-ONE")}${card("ALPHA-TWO")}</body>`);
  writeFileSync(`${genDir5}/page-2.html`, `<!doctype html><title>p2</title><body>${card("BETA-ONE")}${card("BETA-TWO")}</body>`);
  const baseUrl = pathToFileURL(`${genDir5}/page-1.html`).href; // the session opens here
  const dirUrl = pathToFileURL(`${genDir5}/`).href;

  // Single-brace {page} on purpose - the bug was that only {{page}} was interpolated.
  const listTool = {
    name: "list_items",
    description: "List items on a page.",
    inputSchema: { type: "object", properties: { page: { type: "string" } } },
    execution: {
      kind: "browser" as const,
      steps: [
        { action: "navigate" as const, value: `${dirUrl}page-{page}.html` },
        { action: "waitFor" as const, target: { role: "list", selector: "div.card" } },
        { action: "extract" as const, target: { role: "list", selector: "div.card" }, value: "json:listing" },
      ],
    },
    confidence: 0.8,
  };
  const serverTs = generateServer({
    serverId: "12121212-1212-4121-8121-121212121212",
    version: 1,
    url: baseUrl,
    title: "Paginate Fixture",
    tools: [listTool as any],
  }).files.find((f) => f.path === "server.ts")!.content;
  const jsPath = compileServer(genDir5, serverTs);
  // compileServer wipes the dir, so rewrite the fixtures after it.
  writeFileSync(`${genDir5}/page-1.html`, `<!doctype html><title>p1</title><body>${card("ALPHA-ONE")}${card("ALPHA-TWO")}</body>`);
  writeFileSync(`${genDir5}/page-2.html`, `<!doctype html><title>p2</title><body>${card("BETA-ONE")}${card("BETA-TWO")}</body>`);

  try {
    const mod = await import(jsPath);
    const server = mod.createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "paginate-test", version: "1.0.0" });
    await client.connect(ct);
    try {
      // no page, as the first action: the session opens at the base URL (page-1) and the paginated
      // navigate is skipped -> ALPHA cards, instead of a 404 timeout on page-{page}.html.
      const r0: any = await client.callTool({ name: "list_items", arguments: {} });
      const t0 = (r0.content || []).map((c: any) => c.text || "").join(" ");
      assert.equal(r0.isError, false, `no-page errored (expected current-page fallback): ${t0}`);
      assert.match(t0, /ALPHA-ONE/, "missing page should stay on the opening listing, not 404");

      // page=2 -> single-brace {page} fills (the bug was only {{page}} was interpolated) -> BETA cards.
      const r2: any = await client.callTool({ name: "list_items", arguments: { page: "2" } });
      const t2 = (r2.content || []).map((c: any) => c.text || "").join(" ");
      assert.equal(r2.isError, false, `page=2 errored: ${t2}`);
      assert.match(t2, /BETA-ONE/, "single-brace {page} should navigate to page-2");
      assert.doesNotMatch(t2, /ALPHA-ONE/);
    } finally {
      await (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing?.close?.();
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(genDir5, { recursive: true, force: true });
  }
});
