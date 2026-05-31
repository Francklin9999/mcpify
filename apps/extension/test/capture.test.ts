import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureBundle } from "@mcp/types";
import { buildCaptureBundle, templateUrl, inferSchema } from "../lib/capture.ts";

test("net-intercept produces a bundle SHAPE-IDENTICAL to the scraper's (passes the same contract)", async () => {
  const bundle = await buildCaptureBundle({
    url: "https://shop.example.com/products",
    html: "<html><body>shop</body></html>",
    title: "Shop",
    calls: [
      {
        method: "POST",
        url: "https://shop.example.com/api/cart/42",
        requestHeaders: { accept: "application/json", authorization: "Bearer SECRET", cookie: "sid=abc" },
        requestBodySchema: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } } },
        status: 200,
        contentType: "application/json",
        responseBody: { id: 42, items: 3, ok: true },
      },
    ],
    page: {
      headings: ["Shop"],
      visibleText: "Add to cart",
      forms: [
        {
          selector: "form[name=search]",
          method: "GET",
          action: "https://shop.example.com/search",
          purpose: "search",
          fields: [{ name: "q", type: "search", required: true, selector: "input[name=q]" }],
        },
      ],
      actions: [{ kind: "button", label: "Add to cart", selector: "button.add" }],
      appState: [{ source: "__NEXT_DATA__", keys: ["props", "pageProps"], schema: { type: "object" } }],
    },
  });

  // It IS the contract (buildCaptureBundle returns CaptureBundle.parse'd output); re-validate to be explicit.
  assert.doesNotThrow(() => CaptureBundle.parse(bundle));
  assert.equal(bundle.source, "extension");

  const cap = bundle.network[0]!;
  // Secrets scrubbed before leaving the client (04) — and the contract would have REJECTED them otherwise.
  assert.equal(cap.requestHeaders.authorization, undefined);
  assert.equal(cap.requestHeaders.cookie, undefined);
  assert.equal(cap.requestHeaders.accept, "application/json");
  // URL templated, method preserved (POST = action-capable), response schema inferred (no raw values).
  assert.equal(cap.urlPattern, "/api/cart/{id}");
  assert.equal(cap.method, "POST");
  assert.deepEqual(cap.requestBodySchema, {
    type: "object",
    properties: { sku: { type: "string" }, qty: { type: "integer" } },
  });
  assert.deepEqual(cap.responseSchema, {
    type: "object",
    properties: { id: { type: "integer" }, items: { type: "integer" }, ok: { type: "boolean" } },
  });
  assert.equal(bundle.page?.forms?.[0]?.fields[0]?.name, "q");
  assert.equal(bundle.page?.appState?.[0]?.source, "__NEXT_DATA__");
});

test("templateUrl mirrors the scraper (numeric + uuid segments -> {id})", () => {
  assert.equal(templateUrl("https://e.com/api/u/123"), "/api/u/{id}");
  assert.equal(templateUrl("https://e.com/api/u/123e4567-e89b-42d3-a456-426614174000/x"), "/api/u/{id}/x");
});

test("inferSchema is shallow and value-free", () => {
  assert.deepEqual(inferSchema({ a: 1, n: { deep: 1 } }), {
    type: "object",
    properties: { a: { type: "integer" }, n: { type: "object" } },
  });
});
