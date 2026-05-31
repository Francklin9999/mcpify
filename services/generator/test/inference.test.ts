import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CaptureBundle } from "@mcp/types";
import { inferTools, type InferenceClient } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const bundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;
const validTool = repoFixture("tool-definitions/sample-http-tool.json");

/** A client that returns whatever raw string we hand it - stands in for Claude. */
const fakeClient = (raw: string): InferenceClient => ({ proposeTools: async () => raw });

test("keeps valid tools and DROPS invalid ones (the gate)", async () => {
  const invalid = { name: "BadName", description: "", execution: { kind: "telepathy" } };
  const { result, droppedCount } = await inferTools(
    bundle,
    fakeClient(JSON.stringify([validTool, invalid])),
  );
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]!.name, "get_product");
  assert.equal(droppedCount, 1);
});

test("aggregate confidence is computed over SURVIVORS only", async () => {
  const second = { ...validTool, name: "list_products", confidence: 0.7 };
  const { result } = await inferTools(bundle, fakeClient(JSON.stringify([validTool, second])));
  assert.equal(result.tools.length, 2);
  assert.equal(result.confidence, 0.8); // mean(0.9, 0.7)
});

test("all-invalid response: invalid tools dropped, content-tool floor applied", async () => {
  const { result, droppedCount } = await inferTools(bundle, fakeClient(JSON.stringify([{ junk: 1 }, 42])));
  assert.equal(droppedCount, 2); // both invalid candidates dropped
  assert.equal(result.tools.length, 1); // ...but the floor keeps the server usable
  assert.equal(result.tools[0]!.name, "fetch_page_content");
});

test("non-JSON model output does not throw - falls back to the content tool", async () => {
  const { result } = await inferTools(bundle, fakeClient("here are your tools: {oops"));
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]!.name, "fetch_page_content");
});

test("accepts the { tools: [...] } envelope shape too", async () => {
  const { result } = await inferTools(bundle, fakeClient(JSON.stringify({ tools: [validTool] })));
  assert.equal(result.tools.length, 1);
});

test("floor: an inference source that returns ZERO valid tools still yields the content tool", async () => {
  // e.g. OpenAI on a content site emits no http tools, or emits only invalid ones.
  const { result } = await inferTools(bundle, fakeClient(JSON.stringify({ tools: [] })));
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]!.name, "fetch_page_content");
  assert.equal(result.tools[0]!.execution.kind, "http");
});

test("dedups tools by name (real sites fire the same templated endpoint repeatedly)", async () => {
  // 3 valid tools, same name -> would crash registerTool ("already registered"); keep 1, drop 2.
  const dup = [validTool, { ...validTool }, { ...validTool }];
  const { result, droppedCount } = await inferTools(bundle, fakeClient(JSON.stringify(dup)));
  assert.equal(result.tools.length, 1);
  assert.equal(droppedCount, 2);
});

test("site recipes add deterministic Amazon tools even when model emits nothing", async () => {
  const amazonBundle: CaptureBundle = {
    ...bundle,
    source: "extension",
    url: "https://www.amazon.ca/-/fr/",
    legalMode: "session",
    meta: { ...bundle.meta, title: "Amazon.ca" },
  };
  const { result } = await inferTools(amazonBundle, fakeClient(JSON.stringify({ tools: [] })));
  assert.ok(result.tools.some((tool) => tool.name === "search_products"));
  assert.ok(result.tools.some((tool) => tool.name === "get_product_page"));
});
