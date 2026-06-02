import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ForgeClient, type FetchLike } from "../src/client.js";
import { createServer } from "../src/server.js";

// A scriptable fake fetch: each entry matches a path substring + method and returns a canned response.
type Route = { match: (url: string, init: any) => boolean; res: () => any };
function fakeFetch(routes: Route[]): { fetchImpl: FetchLike; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: FetchLike = async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const r = routes.find((x) => x.match(url, init ?? {}));
    if (!r) throw new Error(`no fake route for ${init?.method ?? "GET"} ${url}`);
    const payload = r.res();
    return {
      ok: payload.status ? payload.status < 400 : true,
      status: payload.status ?? 200,
      json: async () => payload.body,
      text: async () => JSON.stringify(payload.body),
    };
  };
  return { fetchImpl, calls };
}

async function connect(deps: Parameters<typeof createServer>[0]) {
  const server = createServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forge-test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

const SAMPLE_ARTIFACT = {
  serverId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  tools: [
    { name: "search_gems", description: "Search RubyGems" },
    { name: "get_gem", description: "Get a gem by name" },
  ],
};

test("exposes the meta toolset", async () => {
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl: fakeFetch([]).fetchImpl });
  const { client: mcp } = await connect({ client });
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["download_mcp_server", "forge_job_status", "forge_mcp_server", "get_mcp_server", "search_mcp_catalog"]);
});

test("forge_mcp_server: enqueue -> poll -> done returns the new server's tools + download URL", async () => {
  let polls = 0;
  const { fetchImpl } = fakeFetch([
    { match: (u, i) => u.endsWith("/api/generate") && i.method === "POST", res: () => ({ body: { jobId: "job-1" } }) },
    {
      match: (u) => u.includes("/api/jobs/job-1"),
      res: () => (++polls >= 2 ? { body: { status: "done", result: SAMPLE_ARTIFACT } } : { body: { status: "running" } }),
    },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client, waitMs: 5_000, pollEveryMs: 10 });
  const r: any = await mcp.callTool({ name: "forge_mcp_server", arguments: { url: "https://rubygems.org" } });
  assert.equal(r.isError, undefined);
  const out = r.content[0].text;
  assert.match(out, /Forged a new MCP server/);
  assert.match(out, /search_gems/);
  assert.match(out, /get_gem/);
  assert.match(out, /11111111-1111-4111-8111-111111111111/);
  assert.match(out, /\/api\/servers\/.*\/download\/1/);
});

test("forge_mcp_server: a still-QUEUED job times out with a 'is the worker running?' hint + jobId", async () => {
  const { fetchImpl } = fakeFetch([
    { match: (u, i) => u.endsWith("/api/generate") && i.method === "POST", res: () => ({ body: { jobId: "job-stuck" } }) },
    { match: (u) => u.includes("/api/jobs/job-stuck"), res: () => ({ body: { status: "queued" } }) },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client, waitMs: 40, pollEveryMs: 10 });
  const r: any = await mcp.callTool({ name: "forge_mcp_server", arguments: { url: "https://x.com" } });
  const out = r.content[0].text;
  assert.match(out, /still QUEUED/);
  assert.match(out, /worker running/i);
  assert.match(out, /job-stuck/);
  assert.match(out, /forge_job_status/);
});

test("forge_mcp_server: wait=false returns immediately with the jobId", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { match: (u, i) => u.endsWith("/api/generate") && i.method === "POST", res: () => ({ body: { jobId: "job-async" } }) },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client });
  const r: any = await mcp.callTool({ name: "forge_mcp_server", arguments: { url: "https://x.com", wait: false } });
  assert.match(r.content[0].text, /job-async/);
  assert.ok(!calls.some((c) => c.url.includes("/api/jobs/")), "wait=false must not poll");
});

test("forge_mcp_server: a failed job is reported as an error", async () => {
  const { fetchImpl } = fakeFetch([
    { match: (u, i) => u.endsWith("/api/generate") && i.method === "POST", res: () => ({ body: { jobId: "job-fail" } }) },
    { match: (u) => u.includes("/api/jobs/job-fail"), res: () => ({ body: { status: "failed", error: "scrape blocked" } }) },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client, waitMs: 5_000, pollEveryMs: 10 });
  const r: any = await mcp.callTool({ name: "forge_mcp_server", arguments: { url: "https://x.com" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /failed: scrape blocked/);
});

test("an unreachable Forge API yields a clear error, not a hang", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const client = new ForgeClient({ base: "http://down.test", fetchImpl });
  const { client: mcp } = await connect({ client });
  const r: any = await mcp.callTool({ name: "forge_mcp_server", arguments: { url: "https://x.com", wait: false } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unreachable at http:\/\/down\.test/);
  assert.match(r.content[0].text, /MCP_FORGE_API_BASE/);
});

test("forge_job_status: returns the finished server when done", async () => {
  const { fetchImpl } = fakeFetch([
    { match: (u) => u.includes("/api/jobs/job-1"), res: () => ({ body: { status: "done", result: SAMPLE_ARTIFACT } }) },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client });
  const r: any = await mcp.callTool({ name: "forge_job_status", arguments: { jobId: "job-1" } });
  assert.match(r.content[0].text, /search_gems/);
});

test("search_mcp_catalog lists matching servers", async () => {
  const { fetchImpl } = fakeFetch([
    {
      match: (u) => u.includes("/api/registry"),
      res: () => ({ body: [{ serverId: "s1", title: "RubyGems", url: "https://rubygems.org", toolCount: 2, confidence: 0.9 }] }),
    },
  ]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client });
  const r: any = await mcp.callTool({ name: "search_mcp_catalog", arguments: { q: "ruby" } });
  assert.match(r.content[0].text, /RubyGems/);
  assert.match(r.content[0].text, /s1/);
});

test("get_mcp_server + download_mcp_server return detail and a download URL", async () => {
  const detail = {
    serverId: "s9",
    title: "Books",
    url: "https://books.toscrape.com",
    tier: "auto_gen",
    status: "active",
    confidence: 0.8,
    currentVersion: 2,
    tools: [{ name: "list_books", description: "List books" }],
  };
  const { fetchImpl } = fakeFetch([{ match: (u) => u.includes("/api/servers/s9"), res: () => ({ body: detail }) }]);
  const client = new ForgeClient({ base: "http://forge.test", fetchImpl });
  const { client: mcp } = await connect({ client });
  const got: any = await mcp.callTool({ name: "get_mcp_server", arguments: { serverId: "s9" } });
  assert.match(got.content[0].text, /list_books/);
  assert.match(got.content[0].text, /download\/2/);
  const dl: any = await mcp.callTool({ name: "download_mcp_server", arguments: { serverId: "s9" } });
  assert.match(dl.content[0].text, /\/api\/servers\/s9\/download\/2/);
});
