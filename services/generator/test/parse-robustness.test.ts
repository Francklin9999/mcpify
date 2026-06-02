import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeBundleHtml, inferTools, HeuristicInferenceClient } from "../src/index.js";
import type { CaptureBundle, NetworkCapture } from "@mcp/types";

/**
 * Robustness gate over a real-world HTML corpus (fixtures/real-world-html/): pages captured from live sites
 * (curl + Playwright-rendered) plus adversarial and Tier-3 bot-wall fixtures. Asserts tool-OUTPUT-level
 * invariants - the parser must never extract links/forms from non-rendered markup, must respect <base href>,
 * must never throw, and must not emit duplicate tool names. See test/measure-robustness.mjs for the
 * human-readable measurement instrument behind these thresholds.
 */

const corpusDir = fileURLToPath(new URL("../../../../fixtures/real-world-html/", import.meta.url));
const read = (name: string): string => readFileSync(corpusDir + name, "utf8");

const quotesXhr: NetworkCapture = {
  method: "GET",
  urlPattern: "/api/quotes",
  rawUrl: "https://quotes.toscrape.com/api/quotes?page=1",
  requestHeaders: { accept: "application/json" },
  responseSchema: { type: "object", properties: { page: { type: "integer" }, quotes: { type: "array" } } },
  statusCode: 200,
  contentType: "application/json",
};

const META: Record<string, { url: string; tier: 1 | 2 | 3; js?: boolean; network?: NetworkCapture[] }> = {
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
  "tier3-amazon-captcha.html": { url: "https://www.amazon.com/s?k=headphones", tier: 3, js: true },
  "nextjs-app-router-ssr.html": { url: "https://nextjs.org/", tier: 1 },
  "react-dev-pages-router.html": { url: "https://react.dev/learn", tier: 1 },
  "csr-shell-react.html": { url: "https://todomvc.com/examples/react/dist/", tier: 1 },
  "hn-algolia-react-rendered.html": { url: "https://hn.algolia.com/?query=typescript&type=story", tier: 2, js: true },
  "adversarial-script-comment.html": { url: "https://shop.example.com/catalog", tier: 1 },
  "adversarial-base-href.html": { url: "https://www.example-store.com/listing/page-2", tier: 1 },
  "adversarial-base-host.html": { url: "https://shop.example.com/c/sale", tier: 1 },
  "adversarial-malformed.html": { url: "https://malformed.example.com/x", tier: 1 },
};

function bundleFor(name: string, html: string): CaptureBundle {
  const m = META[name] ?? { url: "https://unknown.example.com/", tier: 1 as const };
  return {
    bundleId: "00000000-0000-4000-8000-000000000000",
    source: "scraper",
    url: m.url,
    capturedAt: "2026-06-02T00:00:00.000Z",
    legalMode: "safe",
    tier: m.tier,
    dom: { html, domHash: "sha256:x" },
    network: m.network ?? [],
    meta: { renderedWithJs: !!m.js },
  };
}

const fixtureNames = readdirSync(corpusDir).filter((f) => f.endsWith(".html"));

function httpUrlsOf(tools: Awaited<ReturnType<typeof inferTools>>["result"]["tools"]): string[] {
  const urls: string[] = [];
  for (const t of tools) {
    if (t.execution.kind === "http") urls.push(t.execution.request.rawUrl, t.execution.request.urlPattern);
    else for (const s of t.execution.steps) if (typeof s.value === "string") urls.push(s.value);
  }
  return urls;
}

test("corpus: every page yields >=1 tool with unique names and never throws", async () => {
  for (const name of fixtureNames) {
    const bundle = bundleFor(name, read(name));
    const { result } = await inferTools(bundle, new HeuristicInferenceClient());
    assert.ok(result.tools.length >= 1, `${name}: at least the content-tool floor`);
    const names = result.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, `${name}: duplicate tool names: ${names.join(",")}`);
  }
});

test("adversarial: no link/form/tool is extracted from script/style/comment/template", async () => {
  const name = "adversarial-script-comment.html";
  const bundle = bundleFor(name, read(name));
  const analysis = analyzeBundleHtml(bundle);
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const trap = /(COMMENT_TRAP|COMMENT_FORM_TRAP|SCRIPT_LINK_TRAP|SCRIPT_FORM_TRAP|STYLE_TRAP|STYLE_CONTENT_TRAP|TEMPLATE_TRAP|TEMPLATE_FORM_TRAP|should-not-leak|also-trapped|inline-script-xhr)/;
  const all = [...analysis.links.map((l) => l.href), ...analysis.forms.map((f) => f.action), ...httpUrlsOf(result.tools)];
  const leaks = all.filter((u) => trap.test(u));
  assert.deepEqual(leaks, [], `extracted trap URLs from non-rendered markup: ${[...new Set(leaks)].join(", ")}`);
  // The phantom tool that used to ship from a commented-out <form>:
  assert.ok(!result.tools.some((t) => t.name === "post_comment_form_trap"), "no tool from a commented-out form");
  // The real, visible search form IS still mined.
  assert.ok(result.tools.some((t) => t.name === "search"), "real visible search form still mined");
  assert.ok(analysis.links.some((l) => l.href.endsWith("/real-visible-page")), "real visible nav link still found");
});

test("adversarial: relative URLs resolve against <base href>, not the page URL", async () => {
  const name = "adversarial-base-href.html";
  const analysis = analyzeBundleHtml(bundleFor(name, read(name)));
  const products = analysis.links.filter((l) => /products\/4\d/.test(l.href));
  assert.ok(products.length >= 1, "product links found");
  for (const l of products) {
    assert.ok(l.href.startsWith("https://cdn.example-cdn.net/shop/"), `resolved against <base href>: ${l.href}`);
    assert.ok(!l.href.includes("example-store.com"), `not resolved against page URL: ${l.href}`);
  }
});

test("base href on a sibling host: detail tools survive (resolved to the base host, not dropped)", async () => {
  // The discriminating case: page at the apex, <base href> at www. Link-derived detail tools must be kept
  // and point at the base host - not silently dropped as cross-origin relative to the page URL.
  const name = "adversarial-base-host.html";
  const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
  const detail = result.tools.find((t) => t.execution.kind === "http" && t.execution.request.urlPattern.includes("/product/"));
  assert.ok(detail, `detail tool survived a sibling-host <base href> (tools: ${result.tools.map((t) => t.name).join(", ")})`);
  if (detail && detail.execution.kind === "http") {
    assert.ok(detail.execution.request.rawUrl.includes("www.shop.example.com"), `detail tool targets the base host: ${detail.execution.request.rawUrl}`);
  }
  // The search form likewise resolves against the base host.
  const search = result.tools.find((t) => t.name === "search");
  if (search && search.execution.kind === "http") {
    assert.ok(search.execution.request.rawUrl.includes("www.shop.example.com"), "search resolves to the base host");
  }
});

test("Tier 2: an observed JSON XHR becomes an HTTP tool", async () => {
  const name = "quotes-scroll-rendered.html";
  const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
  assert.ok(
    result.tools.some((t) => t.execution.kind === "http" && t.execution.request.urlPattern.includes("/api/quotes")),
    "the /api/quotes XHR yields an HTTP tool",
  );
});

test("Tier 2: from a real AJAX capture (1 data XHR + tracking beacons), only the data endpoint becomes a tool", async () => {
  // tier2-ajax-network.json holds the actual network observed via Playwright on scrapethissite's AJAX page:
  // one real GET /pages/ajax-javascript/?ajax=true&year=… plus google-analytics/google/facebook beacons.
  const network = JSON.parse(read("tier2-ajax-network.json")) as CaptureBundle["network"];
  const bundle: CaptureBundle = {
    bundleId: "00000000-0000-4000-8000-000000000000",
    source: "scraper",
    url: "https://www.scrapethissite.com/pages/ajax-javascript/",
    capturedAt: "2026-06-02T00:00:00.000Z",
    legalMode: "safe",
    tier: 2,
    dom: { html: "<html><body><h1>Oscar Winning Films</h1></body></html>", domHash: "sha256:x" },
    network,
    meta: { renderedWithJs: true },
  };
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const httpTools = result.tools.filter((t) => t.execution.kind === "http");
  // The one real data endpoint is tooled.
  const dataTool = httpTools.find((t) => t.execution.kind === "http" && t.execution.request.urlPattern.includes("ajax-javascript"));
  assert.ok(dataTool, "the real AJAX data endpoint became a tool");
  // Every tracking beacon / static asset was dropped: no tool points at an analytics host or a collect path.
  for (const t of httpTools) {
    if (t.execution.kind !== "http") continue;
    const url = t.execution.request.rawUrl;
    assert.ok(!/google-analytics|googleadservices|\bfacebook\.com|doubleclick/.test(url), `analytics host leaked into a tool: ${url}`);
    assert.ok(!/\/(?:collect|rmkt)\b/.test(url), `tracking collect/rmkt path leaked into a tool: ${url}`);
    assert.ok(!/\.(?:css|js|png|gif|woff2?)$/.test(new URL(url).pathname), `static asset leaked into a tool: ${url}`);
  }
});

test("React/Next/dynamic: realistic Tier-2 SPA (rendered DOM + XHR) yields the data tool, not infra junk", async () => {
  // hn-algolia-react-rendered.html + tier2-react-spa-network.json = the HN Algolia React SPA as actually
  // captured: rendered DOM plus the real Algolia search POST amid telemetry + health-probe + GA beacons.
  const network = JSON.parse(read("tier2-react-spa-network.json")) as CaptureBundle["network"];
  const bundle: CaptureBundle = {
    bundleId: "00000000-0000-4000-8000-000000000000",
    source: "scraper",
    url: "https://hn.algolia.com/?query=typescript&type=story",
    capturedAt: "2026-06-02T00:00:00.000Z",
    legalMode: "safe",
    tier: 2,
    dom: { html: read("hn-algolia-react-rendered.html"), domHash: "sha256:x" },
    network,
    meta: { renderedWithJs: true },
  };
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const http = result.tools.filter((t) => t.execution.kind === "http");
  // The real client-side data API is tooled (the whole point of escalating a SPA to a browser tier).
  assert.ok(
    http.some((t) => t.execution.kind === "http" && t.execution.request.urlPattern.includes("/indexes/Item_dev/query")),
    "the live Algolia search XHR became a data tool",
  );
  // The SaaS infra noise a dynamic app sprays does NOT: telemetry host + liveness probe are dropped.
  for (const t of http) {
    if (t.execution.kind !== "http") continue;
    const { rawUrl, urlPattern } = t.execution.request;
    assert.ok(!/telemetry\./.test(rawUrl), `telemetry host leaked as a tool: ${rawUrl}`);
    assert.ok(!/\/isalive\b|\/health(z|check)?\b/.test(urlPattern), `health/liveness probe leaked as a tool: ${urlPattern}`);
  }
});

test("React/Next SSR: an App-Router (RSC) page still mines real navigational tools from server-rendered links", async () => {
  // App Router SSRs content, so even without client XHR the link miner should find more than the bare floor.
  const name = "nextjs-app-router-ssr.html";
  const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
  assert.ok(result.tools.length >= 2, `SSR React/Next yields tools beyond the content floor (got ${result.tools.map((t) => t.name).join(", ")})`);
});

test("Tier 3: a bot-wall page mines no junk tools (content floor only)", async () => {
  const name = "tier3-cloudflare-challenge.html";
  const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
  const junk = result.tools.filter((t) => !/^(fetch_page_content|extract_page_metadata)$/.test(t.name));
  assert.deepEqual(junk.map((t) => t.name), [], "challenge markup must not produce action tools");
});

test("cleanup: no tool targets an auth/account flow (mis-mined login/signup links)", async () => {
  const authPath = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|sign[-_]?up|signin|signup|register|logout|sso|oauth2?|password[-_]?reset)(?:\/|$)/i;
  for (const name of fixtureNames) {
    const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
    for (const t of result.tools) {
      if (t.execution.kind !== "http") continue;
      // The page the user captured is exempt (it may itself be an auth page).
      if (t.execution.request.urlPattern === new URL(META[name]?.url ?? "https://x/").pathname) continue;
      assert.ok(!authPath.test(t.execution.request.urlPattern), `${name}: '${t.name}' targets an auth flow: ${t.execution.request.urlPattern}`);
    }
  }
});

test("cleanup: no browser navigate value carries a percent-encoded {placeholder} (dead-URL bug)", async () => {
  for (const name of fixtureNames) {
    const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
    for (const t of result.tools) {
      if (t.execution.kind !== "browser") continue;
      for (const step of t.execution.steps) {
        if (typeof step.value === "string") {
          assert.ok(!/%7[Bb]/.test(step.value), `${name}: '${t.name}' has an unsubstitutable encoded placeholder: ${step.value}`);
        }
      }
    }
  }
});

test("Tier 3: a bot-walled KNOWN site still gets useful tools via site recipes (not just the floor)", async () => {
  // The robustness guarantee for hard sites: even when Amazon serves a captcha (no usable forms/links in the
  // challenge markup), the deterministic site recipe still yields search_products / get_product_page. And the
  // captcha's own form (field-keywords -> /errors/validateCaptcha) must NOT leak in as a tool.
  const name = "tier3-amazon-captcha.html";
  const { result } = await inferTools(bundleFor(name, read(name)), new HeuristicInferenceClient());
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("search_products"), `recipe search tool present (got: ${names.join(", ")})`);
  assert.ok(names.includes("get_product_page"), "recipe detail tool present");
  assert.ok(
    !result.tools.some((t) => t.execution.kind === "http" && /validateCaptcha/i.test(t.execution.request.rawUrl)),
    "the captcha form did not become a tool",
  );
});

test("corpus: truncated inputs never throw", async () => {
  for (const name of fixtureNames) {
    const html = read(name);
    for (const frac of [0.1, 0.37, 0.63, 0.9]) {
      const bundle = bundleFor(name, html.slice(0, Math.floor(html.length * frac)));
      await assert.doesNotReject(inferTools(bundle, new HeuristicInferenceClient()), `${name}@${frac}`);
    }
  }
});
