// Hermetic test for site-aware crawling (no browser/network): a fake inner scraper returns canned bundles per URL.
// Asserts: base domain captured FIRST, the given deep path included as PRIMARY, a few same-origin pages explored
// (cross-origin + logout links skipped), and every page's network merged+deduped into one bundle. Also that
// chooseScraper wraps with CrawlingScraper by default and not when FORGE_CRAWL=0.
// Run: node test/crawl-scraper.mjs
import assert from "node:assert";

// Pin crawl knobs before import (module reads them at load).
process.env.FORGE_CRAWL_MAX_PAGES = "4";
process.env.FORGE_CRAWL_BUDGET_MS = "60000";

const { CrawlingScraper, sameOriginLinks } = await import("../dist/src/crawl-scraper.js");
const { assembleBundle } = await import("../dist/src/playwright-scraper.js");
const { chooseScraper } = await import("../dist/src/scraper.js");

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e?.stack ?? e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.message ?? e); } }

const ORIGIN = "https://site.test";
const rootHtml =
  `<nav>` +
  `<a href="/products">Products</a>` +
  `<a href="/about">About</a>` +
  `<a href="https://other.test/x">Other</a>` +   // cross-origin -> skip
  `<a href="/logout">Log out</a>` +              // auth path -> skip
  `<a href="/deep/path">Deep</a>` +              // the given path -> excluded (captured separately)
  `<a href="/products">Dup</a>` +                // duplicate -> deduped
  `</nav>`;

function bundleFor(url, html, apiPaths) {
  return assembleBundle({
    url,
    legalMode: "safe",
    tier: 2,
    html,
    raw: apiPaths.map((p) => ({ method: "GET", rawUrl: ORIGIN + p, requestHeaders: {}, statusCode: 200, contentType: "application/json" })),
  });
}

const PAGES = {
  [`${ORIGIN}/`]: bundleFor(`${ORIGIN}/`, rootHtml, ["/api/home"]),
  [`${ORIGIN}/deep/path`]: bundleFor(`${ORIGIN}/deep/path`, "<h1>Deep page</h1>", ["/api/deep"]),
  [`${ORIGIN}/products`]: bundleFor(`${ORIGIN}/products`, "<h1>Products</h1>", ["/api/products"]),
  [`${ORIGIN}/about`]: bundleFor(`${ORIGIN}/about`, "<h1>About</h1>", ["/api/about"]),
};

const callOrder = [];
const fakeInner = {
  async capture(url) {
    callOrder.push(url);
    const b = PAGES[url];
    if (!b) throw new Error(`fake inner has no page for ${url}`);
    return b;
  },
};

await check("sameOriginLinks: same-origin content links only, root/excluded/assets/auth dropped", () => {
  const links = sameOriginLinks(rootHtml, ORIGIN, new Set([`${ORIGIN}/`, `${ORIGIN}/deep/path`]));
  assert.deepStrictEqual(links, [`${ORIGIN}/products`, `${ORIGIN}/about`], `got ${JSON.stringify(links)}`);
});

await check("crawl: base domain first, given path primary, pages explored, network merged", async () => {
  callOrder.length = 0;
  const crawler = new CrawlingScraper(fakeInner, async () => ({ allowed: true }));
  const bundle = await crawler.capture(`${ORIGIN}/deep/path`, "safe");

  assert.strictEqual(callOrder[0], `${ORIGIN}/`, "base domain captured FIRST");
  assert.ok(callOrder.includes(`${ORIGIN}/deep/path`), "given path captured");
  assert.ok(callOrder.includes(`${ORIGIN}/products`) && callOrder.includes(`${ORIGIN}/about`), "same-origin pages explored");
  assert.ok(!callOrder.includes(`https://other.test/x`), "cross-origin link NOT crawled");
  assert.ok(!callOrder.some((u) => /logout/.test(u)), "logout link NOT crawled");

  assert.strictEqual(bundle.url, `${ORIGIN}/deep/path`, "given path is the primary bundle");
  assert.ok(bundle.dom.html.includes("Deep page"), "primary DOM is the given page");

  const patterns = bundle.network.map((c) => c.urlPattern).sort();
  assert.deepStrictEqual(patterns, ["/api/about", "/api/deep", "/api/home", "/api/products"], `merged endpoints: ${JSON.stringify(patterns)}`);
});

await check("crawl respects FORGE_CRAWL_MAX_PAGES (root + given + explored = max)", async () => {
  callOrder.length = 0;
  const crawler = new CrawlingScraper(fakeInner, async () => ({ allowed: true }));
  await crawler.capture(`${ORIGIN}/deep/path`, "safe");
  assert.ok(callOrder.length <= 4, `captured ${callOrder.length} pages, max 4`);
});

await check("robots-disallowed explored pages are skipped (given + root still captured)", async () => {
  callOrder.length = 0;
  const denyProducts = async (u) => ({ allowed: !/products/.test(u) });
  const crawler = new CrawlingScraper(fakeInner, denyProducts);
  await crawler.capture(`${ORIGIN}/deep/path`, "safe");
  assert.ok(!callOrder.includes(`${ORIGIN}/products`), "robots-disallowed page skipped");
  assert.ok(callOrder.includes(`${ORIGIN}/about`), "allowed page still explored");
  assert.ok(callOrder.includes(`${ORIGIN}/deep/path`), "given path still captured");
});

await check("chooseScraper wraps with CrawlingScraper by default, not when FORGE_CRAWL=0", () => {
  const saved = process.env.FORGE_CRAWL;
  delete process.env.FORGE_CRAWL;
  assert.strictEqual(chooseScraper().scraper.constructor.name, "CrawlingScraper", "wrapped by default");
  process.env.FORGE_CRAWL = "0";
  assert.notStrictEqual(chooseScraper().scraper.constructor.name, "CrawlingScraper", "unwrapped when disabled");
  if (saved === undefined) delete process.env.FORGE_CRAWL; else process.env.FORGE_CRAWL = saved;
});

console.log(failed ? `\ncrawl-scraper: ${failed} FAILED` : "\ncrawl-scraper: all passed");
process.exit(failed ? 1 : 0);
