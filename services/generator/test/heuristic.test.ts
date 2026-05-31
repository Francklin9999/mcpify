import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HeuristicInferenceClient, inferTools } from "../src/index.js";
import type { CaptureBundle } from "@mcp/types";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const contentBundle: CaptureBundle = {
  bundleId: "11111111-1111-4111-8111-111111111111",
  source: "scraper",
  url: "https://fr.wikipedia.org/wiki/Cristiano_Ronaldo",
  capturedAt: "2026-05-30T00:00:00.000Z",
  legalMode: "safe",
  tier: 1,
  dom: { html: "<html></html>", domHash: "sha256:x" },
  network: [],
  meta: { title: "Cristiano Ronaldo", renderedWithJs: false },
};

test("content site (0 network) still yields a usable tool - never a broken zero-tool server", async () => {
  const { result } = await inferTools(contentBundle, new HeuristicInferenceClient());
  assert.ok(result.tools.length >= 1, "must produce at least the content tool");
  const content = result.tools.find((t) => t.name === "fetch_page_content")!;
  assert.ok(content, "fetch_page_content present");
  assert.equal(content.execution.kind, "http");
  if (content.execution.kind === "http") {
    assert.equal(content.execution.request.rawUrl, contentBundle.url);
    assert.equal(content.execution.request.method, "GET");
  }
});

test("API site: content tool + one http tool per observed network call", async () => {
  const apiBundle = { ...contentBundle, network: [repoFixture("capture-bundles/sample-public.json").network[0]] };
  const { result } = await inferTools(apiBundle as CaptureBundle, new HeuristicInferenceClient());
  assert.ok(result.tools.some((t) => t.name === "fetch_page_content"));
  assert.ok(result.tools.length >= 2, "content tool plus the API tool");
});

async function toolsFor(html: string, network: any[] = []) {
  const b = { ...contentBundle, url: "https://site.example.com/page", dom: { html, domHash: "sha256:x" }, network };
  const { result } = await inferTools(b as CaptureBundle, new HeuristicInferenceClient());
  return result.tools;
}

test("form mining: a search form becomes a `search` tool with a required query param", async () => {
  const html = `<html><body><form action="/search" method="get">
    <input type="text" name="q" placeholder="Search">
    <input type="hidden" name="csrf" value="abc">
    <input type="submit" value="Go"></form></body></html>`;
  const tools = await toolsFor(html);
  const search = tools.find((t) => t.name === "search")!;
  assert.ok(search, "search tool mined");
  assert.deepEqual(Object.keys(search.inputSchema.properties as object), ["q"], "only the visible named field");
  assert.deepEqual(search.inputSchema.required, ["q"], "search field is required");
  assert.ok(!("csrf" in (search.inputSchema.properties as object)), "hidden CSRF field excluded");
  if (search.execution.kind === "http") {
    assert.equal(search.execution.request.rawUrl, "https://site.example.com/search");
    assert.equal(search.execution.paramMapping.q!.in, "query");
  }
});

test("form mining: a login form (password field) is skipped entirely", async () => {
  const html = `<html><body><form action="/login" method="post">
    <input type="text" name="user"><input type="password" name="pass"></form></body></html>`;
  const tools = await toolsFor(html);
  assert.ok(!tools.some((t) => t.execution.kind === "http" && /login/.test(t.execution.request.rawUrl)),
    "no tool built from a credential form");
});

test("non-http(s) form actions (javascript:/mailto:) yield no junk tool", async () => {
  const js = await toolsFor(`<form action="javascript:alert(1)"><input name="q"></form>`);
  const mail = await toolsFor(`<form action="mailto:a@b.com"><input name="q"></form>`);
  assert.ok(!js.some((t) => t.name === "search"), "javascript: action skipped");
  assert.ok(!mail.some((t) => t.name === "search"), "mailto: action skipped");
  // still get the content-tool floor
  assert.ok(js.some((t) => t.name === "fetch_page_content"));
});

test("POST form fields map to body params", async () => {
  const html = `<html><body><form action="/submit" method="post">
    <input type="text" name="title"><textarea name="note"></textarea></form></body></html>`;
  const tools = await toolsFor(html);
  const t = tools.find((x) => x.execution.kind === "http" && /submit/.test(x.execution.request.rawUrl))!;
  assert.ok(t);
  if (t.execution.kind === "http") {
    assert.equal(t.execution.request.method, "POST");
    assert.equal(t.execution.paramMapping.title!.in, "body");
    assert.equal(t.execution.paramMapping.note!.in, "body");
  }
});

test("network tool: query params extracted as OPTIONAL, tracking params dropped, path param required", async () => {
  const cap = {
    method: "GET",
    urlPattern: "/api/items/{id}",
    rawUrl: "https://site.example.com/api/items/7?q=shoes&limit=5&utm_source=ad&pd_rd_w=junk",
    requestHeaders: { accept: "application/json" },
    statusCode: 200,
    contentType: "application/json",
  };
  const tools = await toolsFor("<html></html>", [cap]);
  const t = tools.find((x) => x.execution.kind === "http" && x.execution.request.urlPattern === "/api/items/{id}")!;
  assert.ok(t, "network tool built");
  const props = Object.keys(t.inputSchema.properties as object).sort();
  assert.deepEqual(props, ["id", "limit", "q"], "id + real query params; tracking params dropped");
  assert.deepEqual(t.inputSchema.required, ["id"], "only the path param is required");
  if (t.execution.kind === "http") {
    assert.equal(t.execution.paramMapping.q!.in, "query");
    assert.equal(t.execution.paramMapping.id!.in, "path");
  }
});

test("network tool: request body schema becomes body params for POST actions", async () => {
  const cap = {
    method: "POST",
    urlPattern: "/api/search",
    rawUrl: "https://site.example.com/api/search",
    requestHeaders: { accept: "application/json", "content-type": "application/json" },
    requestBodySchema: {
      type: "object",
      properties: { query: { type: "string" }, page: { type: "integer" } },
    },
    statusCode: 200,
    contentType: "application/json",
  };
  const tools = await toolsFor("<html></html>", [cap]);
  const t = tools.find((x) => x.execution.kind === "http" && x.execution.request.urlPattern === "/api/search")!;
  assert.ok(t);
  if (t.execution.kind === "http") {
    assert.equal(t.execution.paramMapping.query!.in, "body");
    assert.equal(t.execution.paramMapping.page!.in, "body");
  }
});

test("network tool mining skips analytics and telemetry endpoints", async () => {
  const tools = await toolsFor("<html></html>", [
    {
      method: "POST",
      urlPattern: "/g/collect",
      rawUrl: "https://www.google-analytics.com/g/collect?v=2",
      requestHeaders: { accept: "*/*" },
      statusCode: 204,
      contentType: "text/plain",
    },
    {
      method: "GET",
      urlPattern: "/api/search",
      rawUrl: "https://site.example.com/api/search?q=shoes",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
    {
      method: "HEAD",
      urlPattern: "/rf8vapwa/init.js",
      rawUrl: "https://site.example.com/rf8vapwa/init.js",
      requestHeaders: { accept: "*/*" },
      statusCode: 200,
      contentType: "application/javascript",
    },
    {
      method: "GET",
      urlPattern: "/endpoint",
      rawUrl: "https://site.example.com/endpoint",
      requestHeaders: { accept: "application/json" },
      statusCode: 200,
      contentType: "application/json",
    },
  ]);
  assert.ok(!tools.some((tool) => tool.name.includes("collect")), "telemetry endpoints should be dropped");
  assert.ok(!tools.some((tool) => tool.name.includes("init_js")), "static assets should be dropped");
  assert.ok(!tools.some((tool) => tool.name === "get_endpoint"), "fixed no-input reads should be dropped");
  assert.ok(tools.some((tool) => tool.execution.kind === "http" && tool.execution.request.urlPattern === "/api/search"));
});

test("HTML analysis mining: repeated product links become a detail-page tool without a domain recipe", async () => {
  const html = `<html><body>
    <a href="/products/red-shoe">Red Shoe</a>
    <a href="/products/blue-shoe">Blue Shoe</a>
    <a href="/products/green-shoe">Green Shoe</a>
  </body></html>`;
  const tools = await toolsFor(html);
  const detail = tools.find((t) => t.name === "get_product_page")!;
  assert.ok(detail, "generic product detail tool mined from repeated links");
  if (detail.execution.kind === "http") {
    assert.equal(detail.execution.request.urlPattern, "/products/{id}");
    assert.equal(detail.execution.paramMapping.id!.in, "path");
  }
});

test("structured browser tools are generated for product pages and search/listing pages", async () => {
  const html = `<html><body>
    <a href="/products/red-shoe">Red Shoe</a>
    <a href="/products/blue-shoe">Blue Shoe</a>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Red Shoe","offers":{"price":"49.99","priceCurrency":"CAD"}}
    </script>
  </body></html>`;
  const b = {
    ...contentBundle,
    url: "https://shop.example.com/search?q=shoe",
    dom: { html, domHash: "sha256:x" },
    page: {
      forms: [{
        selector: "form.search",
        method: "GET",
        action: "https://shop.example.com/search",
        purpose: "search",
        submitSelector: "button[type=submit]",
        fields: [{ name: "query", type: "search", required: true, selector: "input[name=query]" }],
      }],
      appState: [{ source: "__NEXT_DATA__", keys: ["products", "filters"], schema: { type: "object" } }],
    },
    network: [],
  } as CaptureBundle;
  const { result } = await inferTools(b, new HeuristicInferenceClient());
  assert.ok(result.tools.some((tool) => tool.name === "extract_page_metadata" && tool.execution.kind === "browser"));
  assert.ok(result.tools.some((tool) => tool.name === "get_product_details" && tool.execution.kind === "browser"));
  assert.ok(result.tools.some((tool) => tool.name === "list_search_results" && tool.execution.kind === "browser"));
  assert.ok(result.tools.some((tool) => tool.name === "search_in_browser" && tool.execution.kind === "browser"));
});

test("travel-style search forms become browser tools with select and enter-capable steps", async () => {
  const b = {
    ...contentBundle,
    url: "https://travel.example.com/flights",
    dom: { html: "<html><body>Flights</body></html>", domHash: "sha256:x" },
    page: {
      forms: [{
        selector: "form.flight-search",
        method: "GET",
        action: "https://travel.example.com/flights/search",
        purpose: "search",
        fields: [
          { name: "from", type: "text", label: "From", required: true, selector: "input[name=from]" },
          { name: "to", type: "text", label: "To", required: true, selector: "input[name=to]" },
          { name: "depart_date", type: "date", label: "Departure date", required: true, selector: "input[name=depart_date]" },
          { name: "cabin", type: "select", label: "Cabin class", required: false, selector: "select[name=cabin]" },
        ],
      }],
    },
    network: [],
  } as CaptureBundle;
  const { result } = await inferTools(b, new HeuristicInferenceClient());
  const travel = result.tools.find((tool) => tool.name === "search_travel_options" && tool.execution.kind === "browser");
  assert.ok(travel, "travel browser tool mined from semantic field labels");
  if (travel?.execution.kind === "browser") {
    assert.ok(travel.execution.steps.some((step) => String(step.action) === "selectOption"), "select fields stay selects");
    assert.ok(
      travel.execution.steps.some((step) => String(step.action) === "pressKey" && step.value === "Enter"),
      "form submit falls back to Enter when no submit button is captured",
    );
  }
});

test("travel pages yield travel listing tools without product-detail false positives", async () => {
  const b = {
    ...contentBundle,
    url: "https://travel.example.com/flights-from/yul/cheap-flights",
    dom: { html: "<html><body><h1>Cheap flights from Montreal to anywhere</h1><p>Prices in CAD</p></body></html>", domHash: "sha256:x" },
    page: {
      visibleText: "Cheap flights from Montreal to anywhere. Round trip fares in CAD.",
    },
    network: [],
  } as CaptureBundle;
  const { result } = await inferTools(b, new HeuristicInferenceClient());
  assert.ok(result.tools.some((tool) => tool.name === "list_travel_options" && tool.execution.kind === "browser"));
  assert.ok(!result.tools.some((tool) => tool.name === "get_product_details"), "travel pages should not become product detail tools");
});

test("visible page actions become browser tools like add_to_cart and next-page controls", async () => {
  const b = {
    ...contentBundle,
    url: "https://shop.example.com/products/red-shoe",
    dom: { html: "<html><body>Product</body></html>", domHash: "sha256:x" },
    page: {
      actions: [
        { kind: "button", label: "Add to cart", selector: "button.add-to-cart" },
        { kind: "link", label: "Next", selector: "a.next", href: "https://shop.example.com/products?page=2" },
      ],
    },
    network: [],
  } as CaptureBundle;
  const { result } = await inferTools(b, new HeuristicInferenceClient());
  assert.ok(result.tools.some((tool) => tool.name === "add_to_cart" && tool.execution.kind === "browser"));
  assert.ok(result.tools.some((tool) => tool.name === "go_to_next_page" && tool.execution.kind === "browser"));
});

test("JSON-LD SearchAction becomes a search tool without relying on visible form markup", async () => {
  const html = `<html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https://docs.example.com/search?q={search_term_string}","query-input":"required name=search_term_string"}}
    </script>
  </head><body></body></html>`;
  const tools = await toolsFor(html);
  const search = tools.find((t) => t.name === "search")!;
  assert.ok(search, "search tool mined from SearchAction");
  if (search.execution.kind === "http") {
    assert.equal(search.execution.request.urlPattern, "/search");
    assert.equal(search.execution.paramMapping.query!.key, "q");
  }
});

test("repeated query links become a browse or pagination tool", async () => {
  const html = `<html><body>
    <a href="/catalog?category=shoes&page=1">Shoes 1</a>
    <a href="/catalog?category=shoes&page=2">Shoes 2</a>
    <a href="/catalog?category=hats&page=1">Hats 1</a>
  </body></html>`;
  const tools = await toolsFor(html);
  const listing = tools.find((t) => t.name === "paginate_results" || t.name === "browse_listing")!;
  assert.ok(listing, "listing tool mined from repeated query links");
  if (listing.execution.kind === "http") {
    assert.equal(listing.execution.request.urlPattern, "/catalog");
    assert.equal(listing.execution.paramMapping.category!.in, "query");
    assert.equal(listing.execution.paramMapping.page!.in, "query");
  }
});

test("current page query pattern yields a search tool even if HTML is otherwise empty", async () => {
  const b = {
    ...contentBundle,
    url: "https://packages.example.com/search?_nkw=laptop&page=2",
    dom: { html: "<html><body>challenge</body></html>", domHash: "sha256:x" },
    network: [],
  };
  const { result } = await inferTools(b as CaptureBundle, new HeuristicInferenceClient());
  const search = result.tools.find((t) => t.name === "search")!;
  assert.ok(search, "search tool mined from current page URL");
  if (search.execution.kind === "http") {
    assert.equal(search.execution.request.urlPattern, "/search");
    assert.equal(search.execution.paramMapping.query?.key || search.execution.paramMapping._nkw?.key, "_nkw");
  }
});
