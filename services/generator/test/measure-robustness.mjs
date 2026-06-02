/**
 * Standalone robustness MEASUREMENT instrument (not a pass/fail test).
 *
 * Runs the REAL parsing + tool-inference pipeline (analyzeBundleHtml + inferTools/HeuristicInferenceClient)
 * over the real-world HTML corpus in fixtures/real-world-html/ and prints findings: tool counts/names per
 * fixture, sentinel leaks (markup hidden in <script>/<style>/comments/<template>/<noscript>), <base href>
 * resolution, throw-safety on truncated/huge/malformed input, and worst-case runtime.
 *
 * Usage: npm run build --workspace=@mcp/generator && node services/generator/test/measure-robustness.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { analyzeBundleHtml, inferTools, HeuristicInferenceClient } from "../dist/src/index.js";

const corpusDir = fileURLToPath(new URL("../../../fixtures/real-world-html/", import.meta.url));
const read = (name) => readFileSync(corpusDir + name, "utf8");

// Per-fixture metadata: URL the page was captured from, scraper tier, JS-render flag, observed network.
const QUOTES_API_SCHEMA = {
  type: "object",
  properties: {
    has_next: { type: "boolean" },
    page: { type: "integer" },
    quotes: { type: "array" },
  },
};
const quotesXhr = {
  method: "GET",
  urlPattern: "/api/quotes",
  rawUrl: "https://quotes.toscrape.com/api/quotes?page=1",
  requestHeaders: { accept: "application/json" },
  responseSchema: QUOTES_API_SCHEMA,
  statusCode: 200,
  contentType: "application/json",
};

const FIXTURES = {
  "hackernews.html": { url: "https://news.ycombinator.com/", tier: 1 },
  "rubygems-rails.html": { url: "https://rubygems.org/gems/rails", tier: 1 },
  "books-toscrape.html": { url: "https://books.toscrape.com/", tier: 1 },
  "books-toscrape-product.html": { url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", tier: 1 },
  "pypi-requests.html": { url: "https://pypi.org/project/requests/", tier: 1 },
  "pypi-search.html": { url: "https://pypi.org/search/?q=http", tier: 1 },
  "mdn-fetch.html": { url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API", tier: 1 },
  "wikipedia-web.html": { url: "https://en.wikipedia.org/wiki/Web_scraping", tier: 1 },
  "npm-express.html": { url: "https://www.npmjs.com/package/express", tier: 1 },
  "github-explore.html": { url: "https://github.com/topics/javascript", tier: 1 },
  "stackoverflow.html": { url: "https://stackoverflow.com/questions/tagged/python", tier: 1 },
  "quotes-js-rendered.html": { url: "https://quotes.toscrape.com/js/", tier: 2, js: true },
  "quotes-scroll-rendered.html": { url: "https://quotes.toscrape.com/scroll", tier: 2, js: true, network: [quotesXhr] },
  "tier3-cloudflare-challenge.html": { url: "https://www.example-shop.com/", tier: 3, js: true },
  "adversarial-script-comment.html": { url: "https://shop.example.com/catalog", tier: 1 },
  "adversarial-base-href.html": { url: "https://www.example-store.com/listing/page-2", tier: 1 },
  "adversarial-malformed.html": { url: "https://malformed.example.com/x", tier: 1 },
};

function bundleFor(name, html) {
  const m = FIXTURES[name] ?? { url: "https://unknown.example.com/", tier: 1 };
  return {
    bundleId: "00000000-0000-4000-8000-000000000000",
    source: "scraper",
    url: m.url,
    capturedAt: "2026-06-02T00:00:00.000Z",
    legalMode: "safe",
    tier: m.tier,
    dom: { html, domHash: "sha256:x" },
    network: m.network ?? [],
    meta: { title: undefined, renderedWithJs: !!m.js },
  };
}

// Sentinels planted in adversarial-script-comment.html that must NEVER appear in extracted output.
// (noscript is intentionally NOT a trap: its fallback markup is legitimate and must be kept.)
const TRAP_RE = /(COMMENT_TRAP|COMMENT_FORM_TRAP|SCRIPT_LINK_TRAP|SCRIPT_FORM_TRAP|STYLE_TRAP|STYLE_CONTENT_TRAP|TEMPLATE_TRAP|TEMPLATE_FORM_TRAP|should-not-leak|also-trapped|inline-script-xhr)/;

function extractedUrls(analysis, tools) {
  const urls = [];
  for (const l of analysis.links) urls.push(l.href);
  for (const f of analysis.forms) urls.push(f.action);
  for (const p of analysis.detailLinkPatterns) urls.push(p.rawUrl, p.urlPattern);
  for (const p of analysis.queryLinkPatterns) urls.push(p.rawUrl, p.urlPattern);
  for (const p of analysis.searchActions) urls.push(p.rawUrl, p.urlPattern);
  for (const t of tools) {
    if (t.execution?.kind === "http") urls.push(t.execution.request.rawUrl, t.execution.request.urlPattern);
    if (t.execution?.kind === "browser") for (const s of t.execution.steps) if (typeof s.value === "string") urls.push(s.value);
  }
  return urls;
}

const findings = [];
const note = (sev, fixture, msg) => findings.push({ sev, fixture, msg });

console.log("\n=== ROBUSTNESS MEASUREMENT (current code) ===\n");
const names = readdirSync(corpusDir).filter((f) => f.endsWith(".html"));
let worst = { name: "", ms: 0 };

for (const name of names) {
  const html = read(name);
  let analysis, tools, ms;
  try {
    const t0 = performance.now();
    const bundle = bundleFor(name, html);
    analysis = analyzeBundleHtml(bundle);
    const out = await inferTools(bundle, new HeuristicInferenceClient());
    tools = out.result.tools;
    ms = performance.now() - t0;
  } catch (err) {
    note("THROW", name, `pipeline threw: ${err?.stack?.split("\n").slice(0, 3).join(" | ")}`);
    continue;
  }
  if (ms > worst.ms) worst = { name, ms };

  const toolNames = tools.map((t) => t.name);
  console.log(`• ${name}  (${(html.length / 1024).toFixed(0)}KB)  -> ${tools.length} tools, ${analysis.links.length} links, ${analysis.forms.length} forms`);
  console.log(`    tools: ${toolNames.join(", ")}`);
  console.log(`    kinds: ${analysis.likelyPageKinds.join(",") || "(none)"}  jsonLd: ${analysis.jsonLdTypes.slice(0, 6).join(",") || "(none)"}  ${ms.toFixed(1)}ms`);

  // Invariant: duplicate tool names (MCP registerTool throws on a dup).
  const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
  if (dupes.length) note("DUP", name, `duplicate tool names: ${[...new Set(dupes)].join(", ")}`);

  // Invariant: semantic redundancy (the "same tool over and over" smell).
  const searchish = toolNames.filter((n) => /^(search|list_search_results|search_in_browser|search_products)$/.test(n));
  if (searchish.length >= 3) note("SEMDUP", name, `${searchish.length} near-duplicate search tools: ${searchish.join(", ")}`);

  // Invariant: no sentinel leak from script/style/comment/template/noscript.
  if (name === "adversarial-script-comment.html") {
    const leaks = extractedUrls(analysis, tools).filter((u) => TRAP_RE.test(u));
    if (leaks.length) note("LEAK", name, `extracted ${leaks.length} trap URL(s): ${[...new Set(leaks)].join(", ")}`);
    const foundReal = extractedUrls(analysis, tools).some((u) => /\/search\b/.test(u)) && analysis.links.some((l) => /real-visible-page/.test(l.href));
    if (!foundReal) note("MISS", name, `did NOT extract the real visible search form / nav link`);
  }

  // Invariant: <base href> respected for relative URL resolution.
  if (name === "adversarial-base-href.html") {
    const productLinks = analysis.links.filter((l) => /products\/4\d/.test(l.href));
    const wrongBase = productLinks.filter((l) => l.href.includes("example-store.com"));
    if (wrongBase.length) note("BASE", name, `${wrongBase.length} relative URLs resolved against page URL not <base href>: e.g. ${wrongBase[0]?.href}`);
    if (!productLinks.some((l) => l.href.includes("example-cdn.net"))) note("BASE", name, `<base href> ignored: no product link resolved to cdn.example-cdn.net`);
  }

  // Tier 2: an observed JSON XHR should become an HTTP tool.
  if (name === "quotes-scroll-rendered.html") {
    if (!tools.some((t) => t.execution?.kind === "http" && /\/api\/quotes/.test(t.execution.request.urlPattern))) {
      note("TIER2", name, `observed /api/quotes XHR did not yield an HTTP tool`);
    }
  }

  // Tier 3: a bot-wall page should NOT mine junk tools from challenge markup; content floor is acceptable.
  if (name === "tier3-cloudflare-challenge.html") {
    const junk = toolNames.filter((n) => !/^fetch_page_content$|^extract_page_metadata$/.test(n));
    if (junk.length) note("TIER3", name, `bot-wall page produced ${junk.length} non-floor tools: ${junk.join(", ")}`);
  }
}

// Throw-safety: truncate every fixture at many cut points; the pipeline must never throw.
console.log("\n--- throw-safety: truncated inputs ---");
let truncThrows = 0;
for (const name of names) {
  const html = read(name);
  for (const frac of [0.05, 0.17, 0.33, 0.5, 0.71, 0.88, 0.97]) {
    const cut = html.slice(0, Math.floor(html.length * frac));
    try {
      const b = bundleFor(name, cut);
      analyzeBundleHtml(b);
      await inferTools(b, new HeuristicInferenceClient());
    } catch (err) {
      truncThrows++;
      note("THROW", `${name}@${frac}`, `truncated input threw: ${String(err?.message).slice(0, 120)}`);
    }
  }
}
console.log(truncThrows === 0 ? "  OK: no throws across all truncations" : `  ${truncThrows} throwing truncations`);

// Runtime bound on a large, link/form-dense, partly-malformed page (ReDoS / quadratic-scan guard).
console.log("\n--- runtime bound: large synthetic page ---");
const bigParts = ['<html><head><title>big</title><base href="https://b.example/app/"></head><body>'];
for (let i = 0; i < 8000; i++) bigParts.push(`<a href="/p/${i}">Item ${i}</a><form action="/f/${i}"><input name="q${i}"></form>`);
bigParts.push("<a href='/unterminated".repeat(2000)); // pathological unterminated tags
const bigHtml = bigParts.join("");
const tBig = performance.now();
try {
  const b = bundleFor("__big__", bigHtml);
  const a = analyzeBundleHtml(b);
  await inferTools(b, new HeuristicInferenceClient());
  const bigMs = performance.now() - tBig;
  console.log(`  ${(bigHtml.length / 1024 / 1024).toFixed(2)}MB page -> ${bigMs.toFixed(0)}ms, ${a.links.length} links`);
  if (bigMs > 2000) note("SLOW", "__big__", `large page took ${bigMs.toFixed(0)}ms (> 2000ms budget)`);
} catch (err) {
  note("THROW", "__big__", `large page threw: ${String(err?.message).slice(0, 120)}`);
}

// Worst real-fixture runtime.
console.log(`\n  worst real-fixture runtime: ${worst.name} ${worst.ms.toFixed(1)}ms`);

// Summary.
console.log("\n=== FINDINGS ===");
if (findings.length === 0) console.log("  none — all invariants hold.");
for (const f of findings) console.log(`  [${f.sev}] ${f.fixture}: ${f.msg}`);
console.log(`\n  total findings: ${findings.length}\n`);
