import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaptureBundle, ToolDefinition } from "@mcp/types";
import { coverageOf, computeDelta, discoverMore, toolSig } from "../src/incremental.js";
import type { InferenceClient } from "../src/inference.js";

// builders
function netCapture(method: string, urlPattern: string, rawUrl: string) {
  return { method, urlPattern, rawUrl, requestHeaders: { accept: "application/json" }, statusCode: 200, contentType: "application/json" };
}

function bundle(network: ReturnType<typeof netCapture>[], over: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    bundleId: "11111111-1111-4111-8111-111111111111",
    source: "extension",
    url: "https://shop.example.com/",
    capturedAt: "2026-05-30T00:00:00.000Z",
    legalMode: "session",
    dom: { html: "<html><body>shop</body></html>", domHash: "sha256:abc" },
    network,
    meta: { renderedWithJs: true, title: "Shop" },
    ...over,
  } as CaptureBundle;
}

function httpTool(name: string, method: string, urlPattern: string, rawUrl: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execution: {
      kind: "http",
      request: netCapture(method, urlPattern, rawUrl),
      paramMapping: {},
    },
    confidence: 0.7,
  } as ToolDefinition;
}

function mockClient(opts: { more?: string; full?: string } = {}) {
  const calls = { proposeTools: 0, proposeMore: 0, lastDelta: null as any };
  const client: InferenceClient = {
    async proposeTools() {
      calls.proposeTools++;
      return opts.full ?? "[]";
    },
  };
  if (opts.more !== undefined) {
    client.proposeMoreTools = async (delta) => {
      calls.proposeMore++;
      calls.lastDelta = delta;
      return opts.more!;
    };
  }
  return { client, calls };
}

// coverage / sigs
test("toolSig is templated and method-qualified; coverage collects names + sigs", () => {
  const search = httpTool("search_products", "GET", "/s", "https://shop.example.com/s");
  const item = httpTool("get_item", "GET", "/api/items/{id}", "https://shop.example.com/api/items/1");
  assert.equal(toolSig(search), "GET /s");
  assert.equal(toolSig(item), "GET /api/items/{id}");
  const cov = coverageOf([search, item]);
  assert.deepEqual([...cov.names].sort(), ["get_item", "search_products"]);
  assert.ok(cov.sigs.has("GET /s"));
  assert.ok(cov.sigs.has("GET /api/items/{id}"));
});

// computeDelta
test("first capture against empty coverage is all-new", () => {
  const b = bundle([netCapture("GET", "/api/items/{id}", "https://shop.example.com/api/items/1")]);
  const { delta, hasNew } = computeDelta(b, coverageOf([]));
  assert.equal(hasNew, true);
  assert.equal(delta.newNetwork.length, 1);
});

test("re-capture of already-covered structure yields NO delta (no paid call will fire)", () => {
  const b = bundle([netCapture("GET", "/api/items/{id}", "https://shop.example.com/api/items/7")]);
  const coverage = coverageOf([httpTool("get_item", "GET", "/api/items/{id}", "https://shop.example.com/api/items/1")]);
  const { delta, hasNew } = computeDelta(b, coverage);
  assert.equal(hasNew, false);
  assert.equal(delta.newNetwork.length, 0);
});

test("templated sigs collapse an infinite-scroll burst to ONE new unit, not N", () => {
  // The same templated endpoint hit for 50 different ids must not look like 50 new things.
  const calls = Array.from({ length: 50 }, (_, i) => netCapture("GET", "/api/items/{id}", `https://shop.example.com/api/items/${i}`));
  const { delta, hasNew } = computeDelta(bundle(calls), coverageOf([]));
  assert.equal(hasNew, true);
  assert.equal(delta.newNetwork.length, 1, "dedup within the delta by templated sig");
});

test("only the genuinely-new endpoint surfaces when some are already covered", () => {
  const b = bundle([
    netCapture("GET", "/s", "https://shop.example.com/s?k=x"), // already covered
    netCapture("POST", "/api/cart", "https://shop.example.com/api/cart"), // new
  ]);
  const coverage = coverageOf([httpTool("search_products", "GET", "/s", "https://shop.example.com/s")]);
  const { delta, hasNew } = computeDelta(b, coverage);
  assert.equal(hasNew, true);
  assert.deepEqual(delta.newNetwork.map((c) => `${c.method} ${c.urlPattern}`), ["POST /api/cart"]);
  assert.ok(delta.knownToolNames.includes("search_products"));
});

test("visible page actions can trigger delta discovery even without network traffic", () => {
  const b = bundle([], {
    page: {
      actions: [{ kind: "button", label: "Add to cart", selector: "button.add" }],
    } as CaptureBundle["page"],
  });
  const { delta, hasNew } = computeDelta(b, coverageOf([]));
  assert.equal(hasNew, true);
  assert.deepEqual(delta.newActions.map((action) => action.label), ["Add to cart"]);
});

test("already-covered action tools do not retrigger delta discovery", () => {
  const b = bundle([], {
    page: {
      actions: [{ kind: "button", label: "Add to cart", selector: "button.add" }],
    } as CaptureBundle["page"],
  });
  const { delta, hasNew } = computeDelta(b, coverageOf([httpTool("add_to_cart", "POST", "/api/cart", "https://shop.example.com/api/cart")]));
  assert.equal(hasNew, false);
  assert.equal(delta.newActions.length, 0);
});

// discoverMore
test("no new material => NO model call (zero tokens), tools unchanged", async () => {
  const current = [httpTool("get_item", "GET", "/api/items/{id}", "https://shop.example.com/api/items/1")];
  const b = bundle([netCapture("GET", "/api/items/{id}", "https://shop.example.com/api/items/9")]);
  const { client, calls } = mockClient({ more: '{"tools":[]}' });
  const out = await discoverMore(current, b, client);
  assert.equal(out.calledModel, false);
  assert.equal(calls.proposeMore, 0);
  assert.equal(calls.proposeTools, 0);
  assert.equal(out.added.length, 0);
  assert.equal(out.tools.length, 1);
});

test("new material => delta-only model call; dups by name AND by covered endpoint are dropped", async () => {
  const current = [httpTool("search_products", "GET", "/s", "https://shop.example.com/s")];
  const b = bundle([netCapture("POST", "/api/cart", "https://shop.example.com/api/cart")]);
  // model returns: a genuinely-new tool, a name-duplicate, and a same-endpoint capability dup
  const proposal = JSON.stringify({
    tools: [
      httpTool("add_to_cart", "POST", "/api/cart", "https://shop.example.com/api/cart"),
      httpTool("search_products", "GET", "/s2", "https://shop.example.com/s2"), // duplicate NAME
      httpTool("find_products", "GET", "/s", "https://shop.example.com/s"), // duplicate ENDPOINT of search_products
    ],
  });
  const { client, calls } = mockClient({ more: proposal });
  const out = await discoverMore(current, b, client);

  assert.equal(out.calledModel, true);
  assert.equal(calls.proposeMore, 1);
  assert.deepEqual(out.added.map((t) => t.name), ["add_to_cart"]);
  assert.equal(out.droppedCount, 2);
  assert.deepEqual(out.tools.map((t) => t.name), ["search_products", "add_to_cart"]);
  // the model was sent ONLY the new material + known names, never the whole bundle
  assert.deepEqual(calls.lastDelta.newNetwork.map((c: any) => c.urlPattern), ["/api/cart"]);
  assert.deepEqual(calls.lastDelta.knownToolNames, ["search_products"]);
});

test("a client without proposeMoreTools falls back to proposeTools, still filtered to only-new", async () => {
  const current = [httpTool("search_products", "GET", "/s", "https://shop.example.com/s")];
  const b = bundle([netCapture("POST", "/api/cart", "https://shop.example.com/api/cart")]);
  // full proposal includes an existing-name tool (dropped) + a new one (kept)
  const full = JSON.stringify([
    httpTool("search_products", "GET", "/s", "https://shop.example.com/s"),
    httpTool("add_to_cart", "POST", "/api/cart", "https://shop.example.com/api/cart"),
  ]);
  const { client, calls } = mockClient({ full });
  const out = await discoverMore(current, b, client);
  assert.equal(calls.proposeTools, 1);
  assert.equal(calls.proposeMore, 0);
  assert.deepEqual(out.added.map((t) => t.name), ["add_to_cart"]);
});
