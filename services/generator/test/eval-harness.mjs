/**
 * Task-capability EVAL harness (a measurement instrument, not a pass/fail test).
 *
 * measure-robustness.mjs answers "does the pipeline parse anything without crashing?". This answers the
 * harder, product question: "for a diverse set of real sites, does the GENERATED server actually expose the
 * tools an agent would need to DO the task?" - search, browse a listing, open a detail page, paginate, and
 * (for an API) call typed endpoints. It scores capability COVERAGE per site category so "can generate for any
 * website" becomes a tracked number instead of a vibe.
 *
 * It runs fully offline over fixtures/real-world-html/ (+ a synthetic OpenAPI doc for the api-spec path).
 *
 * Usage: npm run build --workspace=@mcp/generator && node services/generator/test/eval-harness.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inferTools, HeuristicInferenceClient, generateServer, openApiToTools, parseOpenApi } from "../dist/src/index.js";

const corpusDir = fileURLToPath(new URL("../../../fixtures/real-world-html/", import.meta.url));
const read = (name) => readFileSync(corpusDir + name, "utf8");

const quotesXhr = {
  method: "GET",
  urlPattern: "/api/quotes",
  rawUrl: "https://quotes.toscrape.com/api/quotes?page=1",
  requestHeaders: { accept: "application/json" },
  responseSchema: { type: "object", properties: { has_next: { type: "boolean" }, page: { type: "integer" }, quotes: { type: "array" } } },
  statusCode: 200,
  contentType: "application/json",
};

// fixture -> { url, tier, js?, network?, category, tasks: [capability keys an agent needs for this site] }
const CASES = {
  "books-toscrape.html": { url: "https://books.toscrape.com/", tier: 1, category: "ecommerce", tasks: ["listing", "detail"] },
  "books-toscrape-product.html": { url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", tier: 1, category: "ecommerce", tasks: ["content"] },
  "pypi-search.html": { url: "https://pypi.org/search/?q=http", tier: 1, category: "package-registry", tasks: ["search", "listing"] },
  "pypi-requests.html": { url: "https://pypi.org/project/requests/", tier: 1, category: "package-registry", tasks: ["content"] },
  "npm-express.html": { url: "https://www.npmjs.com/package/express", tier: 1, category: "package-registry", tasks: ["content"] },
  "rubygems-rails.html": { url: "https://rubygems.org/gems/rails", tier: 1, category: "package-registry", tasks: ["content"] },
  "hackernews.html": { url: "https://news.ycombinator.com/", tier: 1, category: "news", tasks: ["listing"] },
  "stackoverflow.html": { url: "https://stackoverflow.com/questions/tagged/python", tier: 1, category: "qa", tasks: ["listing", "search"] },
  "github-explore.html": { url: "https://github.com/topics/javascript", tier: 1, category: "code", tasks: ["listing"] },
  "mdn-fetch.html": { url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API", tier: 1, category: "docs", tasks: ["content"] },
  "wikipedia-web.html": { url: "https://en.wikipedia.org/wiki/Web_scraping", tier: 1, category: "docs", tasks: ["content"] },
  "quotes-js-rendered.html": { url: "https://quotes.toscrape.com/js/", tier: 2, js: true, category: "spa", tasks: ["listing"] },
  "quotes-scroll-rendered.html": { url: "https://quotes.toscrape.com/scroll", tier: 2, js: true, network: [quotesXhr], category: "spa", tasks: ["listing", "api"] },
};

function bundleFor(name) {
  const m = CASES[name];
  return {
    bundleId: "00000000-0000-4000-8000-000000000000",
    source: "scraper",
    url: m.url,
    capturedAt: "2026-06-02T00:00:00.000Z",
    legalMode: "safe",
    tier: m.tier,
    dom: { html: read(name), domHash: "sha256:x" },
    network: m.network ?? [],
    meta: { renderedWithJs: !!m.js },
  };
}

const SEARCH_PARAM = /^(q|query|search|searchterm|keyword|keywords|term|s|k|text|_nkw)$/i;
const PAGE_PARAM = /^(page|offset|cursor|start|p|after|limit)$/i;

function propsOf(t) {
  return Object.keys((t.inputSchema && t.inputSchema.properties) || {});
}
function pathParam(t) {
  return t.execution?.kind === "http" && /\{\{?\w+\}\}?/.test(t.execution.request.urlPattern || "");
}

// Capability detectors over the generated tool set (the proxy for "an agent could do this task").
function capabilitiesOf(tools) {
  const content = tools.some((t) => /^(fetch_page_content|extract_page_metadata|read_page)$/.test(t.name) || (t.execution?.kind === "browser" && t.execution.steps.some((s) => s.action === "extract")));
  const search = tools.some((t) => propsOf(t).some((p) => SEARCH_PARAM.test(p)) || /search|find/.test(t.name) || (t.execution?.kind === "browser" && t.execution.steps.some((s) => s.action === "fill")));
  const listing = tools.some(
    (t) =>
      /list|browse|search_results|results|feed|index/.test(t.name) ||
      (t.execution?.kind === "browser" && t.execution.steps.some((s) => s.action === "extract" && /listing|list|cards?/.test(String(s.value || "")))),
  );
  const detail = tools.some((t) => pathParam(t) || /get_.*(page|detail|item|product|gem|package|repo|question|post)/.test(t.name) || /^get_\w+_page$/.test(t.name));
  const pagination = tools.some((t) => /next|paginate|more|page/.test(t.name) || propsOf(t).some((p) => PAGE_PARAM.test(p)));
  const api = tools.some((t) => t.execution?.kind === "http" && /\/api\//.test(t.execution.request.urlPattern || ""));
  return { content, search, listing, detail, pagination, api };
}

function emits(name, tools, url) {
  try {
    const artifact = generateServer({
      serverId: "55555555-5555-4555-8555-555555555555",
      version: 1,
      url,
      title: name,
      tools,
      browsing: tools.some((t) => t.execution?.kind === "browser"),
    });
    return artifact.files.some((f) => f.path === "server.ts");
  } catch {
    return false;
  }
}

console.log("\n=== TASK-CAPABILITY EVAL ===\n");
const rows = [];
const byCategory = new Map();

for (const name of Object.keys(CASES)) {
  const c = CASES[name];
  let tools = [];
  let ok = false;
  try {
    const bundle = bundleFor(name);
    tools = (await inferTools(bundle, new HeuristicInferenceClient())).result.tools;
    ok = emits(name, tools, c.url);
  } catch (err) {
    console.log(`• ${name}: PIPELINE THREW ${String(err?.message).slice(0, 100)}`);
    continue;
  }
  const caps = capabilitiesOf(tools);
  const required = c.tasks;
  const met = required.filter((k) => caps[k]);
  const score = required.length ? met.length / required.length : 1;
  rows.push({ name, category: c.category, tools: tools.length, required, met: met.length, score, emits: ok });

  const agg = byCategory.get(c.category) || { total: 0, n: 0 };
  agg.total += score;
  agg.n += 1;
  byCategory.set(c.category, agg);

  const miss = required.filter((k) => !caps[k]);
  console.log(
    `• ${name.padEnd(34)} [${c.category}]  ${tools.length} tools  task ${met.length}/${required.length}` +
      `  ${ok ? "emits✓" : "EMIT✗"}${miss.length ? `  missing: ${miss.join(",")}` : ""}`,
  );
}

// The api-spec path: a published OpenAPI contract should yield typed, parameterized tools.
const SAMPLE_OPENAPI = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/products": { get: { operationId: "listProducts", parameters: [{ name: "q", in: "query", schema: { type: "string" } }] } },
    "/products/{id}": { get: { operationId: "getProduct", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
    "/orders": { post: { operationId: "createOrder", requestBody: { content: { "application/json": { schema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } } } } } },
  },
};
const apiTools = openApiToTools(parseOpenApi(JSON.stringify(SAMPLE_OPENAPI)), "https://api.example.com");
const apiCaps = capabilitiesOf(apiTools);
const apiScore = ["search", "detail"].filter((k) => apiCaps[k]).length / 2;
console.log(`\n• [openapi]  ${apiTools.length} tools from a published spec  (search:${apiCaps.search} detail:${apiCaps.detail} write:${apiTools.some((t) => /create|update|delete/.test(t.name))})  score ${(apiScore * 100).toFixed(0)}%`);
byCategory.set("api", { total: apiScore, n: 1 });

console.log("\n=== CAPABILITY SCORE BY CATEGORY ===");
let overall = 0;
let n = 0;
for (const [cat, agg] of [...byCategory.entries()].sort()) {
  const pct = (agg.total / agg.n) * 100;
  overall += agg.total / agg.n;
  n += 1;
  console.log(`  ${cat.padEnd(18)} ${pct.toFixed(0)}%`);
}
const overallPct = (overall / n) * 100;
console.log(`\n  OVERALL CAPABILITY SCORE: ${overallPct.toFixed(1)}%  (${rows.length} HTML fixtures + 1 OpenAPI, ${n} categories)`);
const emitFails = rows.filter((r) => !r.emits);
console.log(`  artifacts that emit a server: ${rows.length - emitFails.length}/${rows.length}${emitFails.length ? ` (FAILED: ${emitFails.map((r) => r.name).join(", ")})` : ""}`);
console.log("");
