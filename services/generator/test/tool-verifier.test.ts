import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTools, verifyAndFilter, verificationTargets, annotateConfidence, httpProbe, type ProbeFn } from "../src/tool-verifier.js";
import { fetchPublicHttpUrl } from "../src/url-safety.js";
import type { ToolDefinition } from "@mcp/types";

const httpTool = (name: string, method: string, urlPattern: string, rawUrl: string, paramMapping: Record<string, { in: string; key: string }> = {}): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  execution: { kind: "http", request: { method, urlPattern, rawUrl, requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" }, paramMapping: paramMapping as any },
  confidence: 0.55,
});
const browserTool = (name: string): ToolDefinition => ({
  name, description: name, inputSchema: { type: "object", properties: {} },
  execution: { kind: "browser", steps: [{ action: "navigate", value: "https://x/" }] }, confidence: 0.6,
});

/** Fake probe driven by a url -> {status,body} map. */
const fakeProbe = (map: Record<string, { status: number; body: string }>): ProbeFn => async (url) => map[url] ?? null;

test("a live GET tool is verified", async () => {
  const tools = [httpTool("get_gem_page", "GET", "/gems/{gem}", "https://rubygems.org/gems/rails", { gem: { in: "path", key: "gem" } })];
  const r = await verifyTools(tools, fakeProbe({ "https://rubygems.org/gems/rails": { status: 200, body: "<html>rails gem</html>" } }));
  assert.equal(r.verifications[0]!.status, "verified");
  assert.equal(r.verified, 1);
});

test("SAFETY: a POST tool is never replayed — reported not_verifiable", async () => {
  const tools = [httpTool("post_query", "POST", "/1/indexes/x/query", "https://api.algolia.net/1/indexes/x/query")];
  let probed = false;
  const r = await verifyTools(tools, async () => { probed = true; return { status: 200, body: "ok" }; });
  assert.equal(r.verifications[0]!.status, "not_verifiable");
  assert.match(r.verifications[0]!.reason!, /non-idempotent/);
  assert.equal(probed, false, "no live request was issued for a POST tool");
});

test("browser tools and placeholder targets are not_verifiable", async () => {
  const r = await verifyTools(
    [browserTool("extract_page_metadata"), httpTool("get_product_page", "GET", "/dp/{asin}", "https://www.amazon.com/dp/B000000000", { asin: { in: "path", key: "asin" } })],
    fakeProbe({}),
  );
  assert.equal(r.verifications[0]!.status, "not_verifiable");
  assert.equal(r.verifications[1]!.status, "not_verifiable");
  assert.match(r.verifications[1]!.reason!, /placeholder/);
});

test("HTTP 404 is dead", async () => {
  const r = await verifyTools([httpTool("x", "GET", "/x", "https://site/x")], fakeProbe({ "https://site/x": { status: 404, body: "not found" } }));
  assert.equal(r.verifications[0]!.status, "dead");
  assert.equal(r.dead, 1);
});

test("verifyAndFilter drops a dead tool (the books.toscrape prefix bug) but keeps live + not_verifiable ones", async () => {
  // get_product_page has a WRONG template that 404s live (the dropped-/catalogue/ class of bug); fetch_page
  // and a browser tool must survive. This is exactly the safety net for the standalone emit path.
  const tools = [
    httpTool("get_product_page", "GET", "/{id}/index.html", "https://books.toscrape.com/in-her-wake_980/index.html", { id: { in: "path", key: "id" } }),
    httpTool("fetch_page_content", "GET", "/", "https://books.toscrape.com/"),
    browserTool("list_page_items"),
  ];
  const probe = fakeProbe({
    "https://books.toscrape.com/in-her-wake_980/index.html": { status: 404, body: "404 Not Found" },
    "https://books.toscrape.com/": { status: 200, body: "<html>Books to Scrape</html>" },
  });
  const { tools: kept, dropped, report } = await verifyAndFilter(tools, probe);
  assert.deepEqual(kept.map((t) => t.name).sort(), ["fetch_page_content", "list_page_items"]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.name, "get_product_page");
  assert.equal(dropped[0]!.status, "dead");
  assert.equal(report.verified, 1); // fetch_page_content verified live
});

test("200 with an anti-bot challenge body is BLOCKED, never verified", async () => {
  const r = await verifyTools([httpTool("x", "GET", "/x", "https://site/x")], fakeProbe({ "https://site/x": { status: 200, body: "<title>Just a moment...</title> checking your browser captcha" } }));
  assert.equal(r.verifications[0]!.status, "blocked");
  assert.equal(r.verified, 0);
  assert.equal(r.blocked, 1);
});

test("the mic-drop: a FRESH un-captured value proves the template generalizes", async () => {
  const tools = [httpTool("get_gem_page", "GET", "/gems/{gem}", "https://rubygems.org/gems/rails", { gem: { in: "path", key: "gem" } })];
  const r = await verifyTools(tools, fakeProbe({
    "https://rubygems.org/gems/rails": { status: 200, body: "<html>rails</html>" },
    "https://rubygems.org/gems/rspec": { status: 200, body: "<html>rspec gem page</html>" }, // never captured
  }), { freshValues: { gem: "rspec" } });
  assert.equal(r.verifications[0]!.status, "verified");
  assert.equal(r.verifications[0]!.generalized, true, "template proven on the un-captured 'rspec'");
  assert.equal(r.generalized, 1);
});

test("captured-live but fresh-value-fails → verified, but generalized:false (honest)", async () => {
  const tools = [httpTool("get_gem_page", "GET", "/gems/{gem}", "https://rubygems.org/gems/rails", { gem: { in: "path", key: "gem" } })];
  const r = await verifyTools(tools, fakeProbe({
    "https://rubygems.org/gems/rails": { status: 200, body: "<html>rails</html>" },
    "https://rubygems.org/gems/zzz": { status: 404, body: "no" },
  }), { freshValues: { gem: "zzz" } });
  assert.equal(r.verifications[0]!.status, "verified");
  assert.equal(r.verifications[0]!.generalized, false);
});

test("verificationTargets builds a fresh URL from origin + urlPattern", () => {
  const t = verificationTargets(
    httpTool("get_gem_page", "GET", "/gems/{gem}", "https://rubygems.org/gems/rails#", { gem: { in: "path", key: "gem" } }),
    { gem: "sinatra" },
  );
  assert.equal(t.captured?.url, "https://rubygems.org/gems/rails#");
  assert.equal(t.fresh?.url, "https://rubygems.org/gems/sinatra");
});

test("annotateConfidence: verified floors up, generalized higher, dead/blocked damped, not_verifiable untouched", () => {
  const base = httpTool("x", "GET", "/x", "https://s/x");
  assert.equal(annotateConfidence(base, { name: "x", status: "verified" }).confidence, 0.8);
  assert.equal(annotateConfidence(base, { name: "x", status: "verified", generalized: true }).confidence, 0.9);
  assert.equal(annotateConfidence({ ...base, confidence: 0.95 }, { name: "x", status: "verified" }).confidence, 0.95, "never lowers a high confidence");
  assert.equal(annotateConfidence(base, { name: "x", status: "dead" }).confidence, 0.3);
  assert.equal(annotateConfidence(base, { name: "x", status: "blocked" }).confidence, 0.3);
  assert.equal(annotateConfidence(base, { name: "x", status: "not_verifiable" }).confidence, 0.55, "unchanged");
});

test("report gives an honest three-way denominator", async () => {
  const tools = [
    httpTool("live", "GET", "/a", "https://s/a"),
    httpTool("gone", "GET", "/b", "https://s/b"),
    browserTool("browser"),
  ];
  const r = await verifyTools(tools, fakeProbe({ "https://s/a": { status: 200, body: "ok content" }, "https://s/b": { status: 500, body: "err" } }));
  assert.equal(r.verified, 1);
  assert.equal(r.dead, 1);
  assert.equal(r.notVerifiable, 1);
  assert.equal(r.verified + r.dead + r.blocked + r.notVerifiable, tools.length, "every tool is accounted for");
});

test("httpProbe refuses non-idempotent methods and non-http urls (safety guard)", async () => {
  const probe = httpProbe();
  assert.equal(await probe("https://site/x", "POST" as any), null, "POST refused");
  assert.equal(await probe("ftp://site/x", "GET"), null, "non-http refused");
});

test("fetchPublicHttpUrl validates redirects before following them", async () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: any) => {
    requested.push(String(url));
    return {
      status: 302,
      headers: { get: (name: string) => name.toLowerCase() === "location" ? "http://127.0.0.1/admin" : null },
      body: { cancel: async () => undefined },
    } as any;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchPublicHttpUrl("http://93.184.216.34/start"),
      /private|loopback|reserved|non-public/,
    );
    assert.deepEqual(requested, ["http://93.184.216.34/start"], "private redirect target was not fetched");
  } finally {
    globalThis.fetch = realFetch;
  }
});
