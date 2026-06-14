import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { generateServer } from "../src/index.js";
import type { ToolDefinition } from "@mcp/types";

/**
 * Generated-server HTTP runtime upgrades (credential injection, write-gating + dryRun, JSON projection,
 * retry/backoff, binary handling). Compiles a REAL server with the production tsc and drives it over an
 * in-memory MCP client with a mocked global fetch, so every assertion exercises the emitted code path.
 */

const packageRoot = fileURLToPath(new URL("../../", import.meta.url)); // services/generator/
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const genDir = `${packageRoot}.gen-http-runtime`;

const SITE = "https://api.example.com/";

const authedGet: ToolDefinition = {
  name: "get_thing",
  description: "Get a thing by id.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  execution: {
    kind: "http",
    request: {
      method: "GET",
      urlPattern: "/things/{id}",
      rawUrl: "https://api.example.com/things/1",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: { id: { in: "path", key: "id" } },
  },
  confidence: 0.8,
};

const createThing: ToolDefinition = {
  name: "create_thing",
  description: "Create a new thing.",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  execution: {
    kind: "http",
    request: {
      method: "POST",
      urlPattern: "/things",
      rawUrl: "https://api.example.com/things",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: { title: { in: "body", key: "title" } },
  },
  confidence: 0.8,
};

// A read-only POST (search) must NOT be classified as a write.
const searchThings: ToolDefinition = {
  name: "search_things",
  description: "Search things by keyword.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  execution: {
    kind: "http",
    request: {
      method: "POST",
      urlPattern: "/search",
      rawUrl: "https://api.example.com/search",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: { q: { in: "body", key: "q" } },
  },
  confidence: 0.8,
};

const externalGet: ToolDefinition = {
  name: "get_external",
  description: "Fetch a resource from a third-party host.",
  inputSchema: { type: "object", properties: {} },
  execution: {
    kind: "http",
    request: {
      method: "GET",
      urlPattern: "/data",
      rawUrl: "https://other.example.org/data",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: {},
  },
  confidence: 0.6,
};

// A JSON POST API (YouTube InnerTube / LinkedIn Voyager / GraphQL shape): a captured `requestBody` with fixed
// boilerplate (`context`) the caller must NOT supply, plus a variable `query` mapped at its body key path. The
// generated runtime must replay the captured body, keeping `context` and substituting only `query`.
const replaySearch: ToolDefinition = {
  name: "replay_search",
  description: "Replays the site's search API with your query.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  execution: {
    kind: "http",
    request: {
      method: "POST",
      urlPattern: "/v1/search",
      rawUrl: "https://api.example.com/v1/search?prettyPrint=false",
      requestHeaders: { accept: "application/json", "content-type": "application/json" },
      requestBody: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.2024" } }, query: "seed-term" }),
      statusCode: 200,
      contentType: "application/json",
    },
    paramMapping: { query: { in: "body", key: "query" } },
  },
  confidence: 0.7,
};

function compile(): string {
  const serverTs = generateServer({
    serverId: "55555555-5555-4555-8555-555555555555",
    version: 1,
    url: SITE,
    title: "API",
    tools: [authedGet, createThing, searchThings, externalGet, replaySearch],
  }).files.find((f) => f.path === "server.ts")!.content;
  rmSync(genDir, { recursive: true, force: true });
  mkdirSync(genDir, { recursive: true });
  writeFileSync(`${genDir}/server.ts`, serverTs);
  writeFileSync(
    `${genDir}/tsconfig.gen.json`,
    JSON.stringify({
      extends: "../../../tsconfig.base.json",
      compilerOptions: { rootDir: ".", outDir: "./out", declaration: false, declarationMap: false, sourceMap: false, types: ["node"] },
      include: ["server.ts"],
    }),
  );
  const tsc = `${repoRoot}node_modules/.bin/tsc`;
  const res = spawnSync(tsc, ["-p", `${genDir}/tsconfig.gen.json`], { encoding: "utf8" });
  assert.equal(res.status, 0, `tsc failed:\n${res.stdout}\n${res.stderr}`);
  return `${genDir}/out/server.js`;
}

type Captured = { url: string; method?: string; headers?: Record<string, string>; body?: string };
type Responder = (url: string, init: any, call: number) => { status: number; ctype: string; body: string; retryAfter?: string };

function headerMap(h: Record<string, string>) {
  return { get: (k: string) => h[String(k).toLowerCase()] ?? null };
}

let importCounter = 0;

async function withServer(
  fn: (client: Client, ctx: { calls: Captured[]; setResponder: (r: Responder) => void }) => Promise<void>,
): Promise<void> {
  const jsPath = compile();
  // Cache-bust the import so each call re-evaluates the module and re-reads module-load env consts
  // (e.g. HTTP_ALLOW_WRITES) at THIS test's current process.env - ESM otherwise caches by URL.
  const mod = await import(pathToFileURL(jsPath).href + `?v=${++importCounter}`);
  const server = mod.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "http-runtime-test", version: "1.0.0" });
  await client.connect(ct);

  const realFetch = globalThis.fetch;
  const calls: Captured[] = [];
  let callNo = 0;
  let responder: Responder = () => ({ status: 200, ctype: "application/json", body: '{"ok":true}' });
  globalThis.fetch = (async (url: any, init: any) => {
    const n = callNo++;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[String(k).toLowerCase()] = String(v);
    calls.push({ url: String(url), method: init?.method, headers, body: init?.body });
    const r = responder(String(url), init, n);
    const resHeaders: Record<string, string> = { "content-type": r.ctype };
    if (r.retryAfter != null) resHeaders["retry-after"] = r.retryAfter;
    return { ok: r.status >= 200 && r.status < 400, status: r.status, headers: headerMap(resHeaders), text: async () => r.body } as any;
  }) as typeof fetch;

  try {
    await fn(client, { calls, setResponder: (r) => (responder = r) });
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
    await server.close();
    rmSync(genDir, { recursive: true, force: true });
  }
}

test("credentials from env attach to same-origin requests and never leak cross-origin", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  process.env.MCP_AUTH_BEARER = "secret-token";
  process.env.MCP_API_KEY = "key-123";
  process.env.MCP_AUTH_HEADER = "X-Tenant: acme";
  try {
    await withServer(async (client, { calls }) => {
      await client.callTool({ name: "get_thing", arguments: { id: "7" } });
      const sameOrigin = calls.at(-1)!;
      assert.equal(sameOrigin.url, "https://api.example.com/things/7");
      assert.equal(sameOrigin.headers!["authorization"], "Bearer secret-token");
      assert.equal(sameOrigin.headers!["x-api-key"], "key-123");
      assert.equal(sameOrigin.headers!["x-tenant"], "acme");

      await client.callTool({ name: "get_external", arguments: {} });
      const crossOrigin = calls.at(-1)!;
      assert.equal(crossOrigin.url, "https://other.example.org/data");
      assert.equal(crossOrigin.headers!["authorization"], undefined, "bearer must NOT be sent cross-origin");
      assert.equal(crossOrigin.headers!["x-api-key"], undefined, "api key must NOT be sent cross-origin");
      assert.equal(crossOrigin.headers!["x-tenant"], undefined, "custom auth header must NOT be sent cross-origin");
    });
  } finally {
    process.env = saved;
  }
});

test("write tools are gated by default, preview on dryRun, and fire with MCP_ALLOW_WRITES=1", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  delete process.env.MCP_ALLOW_WRITES;
  try {
    await withServer(async (client, { calls, setResponder }) => {
      setResponder(() => ({ status: 200, ctype: "application/json", body: '{"created":true}' }));

      // Default: refuse, nothing sent.
      const refused: any = await client.callTool({ name: "create_thing", arguments: { title: "x" } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /MCP_ALLOW_WRITES/);
      assert.equal(calls.length, 0, "a refused write must not reach fetch");

      // dryRun: preview the request, still nothing sent.
      const dry: any = await client.callTool({ name: "create_thing", arguments: { title: "x", dryRun: true } });
      assert.notEqual(dry.isError, true);
      assert.match(dry.content[0].text, /DRY RUN/);
      assert.match(dry.content[0].text, /POST https:\/\/api\.example\.com\/things/);
      assert.match(dry.content[0].text, /"title":"x"/);
      assert.equal(calls.length, 0, "dryRun must not reach fetch");

      // A read-only POST (search) is NOT gated.
      await client.callTool({ name: "search_things", arguments: { q: "hello" } });
      assert.equal(calls.length, 1, "search (read-only POST) must not be gated");
      assert.equal(calls[0]!.method, "POST");
    });
  } finally {
    process.env = saved;
  }
});

test("a write tool fires when MCP_ALLOW_WRITES=1 is set before the server loads", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  process.env.MCP_ALLOW_WRITES = "1"; // module-load const: must be set BEFORE the (cache-busted) import
  try {
    await withServer(async (client, { calls }) => {
      await client.callTool({ name: "create_thing", arguments: { title: "y" } });
      const sent = calls.at(-1)!;
      assert.equal(sent.method, "POST");
      assert.equal(sent.url, "https://api.example.com/things");
      assert.deepEqual(JSON.parse(sent.body!), { title: "y" });
    });
  } finally {
    process.env = saved;
  }
});

test("JSON responses are projected by select and pretty-printed", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    await withServer(async (client, { setResponder }) => {
      setResponder(() => ({
        status: 200,
        ctype: "application/json",
        body: JSON.stringify({ id: 7, name: "thing", secret: "hide-me", owner: { login: "neo", email: "x" } }),
      }));
      const projected: any = await client.callTool({ name: "get_thing", arguments: { id: "7", select: "id,name,owner.login" } });
      const out: any = JSON.parse(projected.content[0].text);
      // deepStrictEqual enforces EXACT keys, so this also proves unselected fields (secret, owner.email) are dropped.
      assert.deepEqual(out, { id: 7, name: "thing", login: "neo" });

      const full: any = await client.callTool({ name: "get_thing", arguments: { id: "7" } });
      const fullOut: any = JSON.parse(full.content[0].text);
      assert.equal(fullOut.secret, "hide-me", "without select the full body is returned");
    });
  } finally {
    process.env = saved;
  }
});

test("idempotent GET retries on 429 then succeeds; binary responses are summarized not dumped", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  process.env.MCP_HTTP_MAX_RETRIES = "2";
  try {
    await withServer(async (client, { calls, setResponder }) => {
      // First attempt 429, second 200.
      setResponder((_url, _init, call) =>
        call === 0
          ? { status: 429, ctype: "application/json", body: "rate limited", retryAfter: "0" }
          : { status: 200, ctype: "application/json", body: '{"ok":true}' },
      );
      const r: any = await client.callTool({ name: "get_thing", arguments: { id: "1" } });
      assert.equal(calls.length, 2, "a 429 must be retried once");
      assert.notEqual(r.isError, true);
      assert.match(r.content[0].text, /"ok": true/);

      // Binary content-type: do not dump bytes.
      calls.length = 0;
      setResponder(() => ({ status: 200, ctype: "application/pdf", body: "%PDF-1.7 binary..." }));
      const pdf: any = await client.callTool({ name: "get_thing", arguments: { id: "2" } });
      assert.match(pdf.content[0].text, /\[binary response: application\/pdf/);
      assert.ok(!pdf.content[0].text.includes("%PDF-1.7 binary"), "binary bytes must not be dumped");
    });
  } finally {
    process.env = saved;
  }
});

test("captured JSON body is replayed: fixed `context` kept, only the variable field substituted (YouTube/LinkedIn POST APIs)", async () => {
  const saved = { ...process.env };
  process.env.MCP_ALLOW_PRIVATE_HOSTS = "1";
  try {
    await withServer(async (client, { calls }) => {
      const r: any = await client.callTool({ name: "replay_search", arguments: { query: "never gonna give you up" } });
      assert.notEqual(r.isError, true);
      const sent = calls.at(-1)!;
      assert.equal(sent.url, "https://api.example.com/v1/search?prettyPrint=false");
      assert.equal(String(sent.method).toUpperCase(), "POST");
      const body = JSON.parse(String(sent.body));
      // The caller's value replaced the seed query...
      assert.equal(body.query, "never gonna give you up", "the variable field was substituted");
      // ...while the fixed boilerplate the caller never supplied is replayed intact.
      assert.equal(body.context?.client?.clientName, "WEB", "fixed `context` boilerplate is preserved");
      assert.equal(body.context?.client?.clientVersion, "2.2024", "fixed `context` values are preserved");
      assert.equal(sent.headers!["content-type"], "application/json", "JSON content-type set for the replayed body");
    });
  } finally {
    process.env = saved;
  }
});
