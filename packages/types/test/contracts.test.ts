import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CaptureBundle,
  NetworkCapture,
  ToolDefinition,
  ExecutionStrategy,
  Job,
  GenerateRequest,
  Confidence,
  clampConfidence,
  aggregateConfidence,
  scrubHeaders,
  SECRET_HEADERS,
  SECRET_FIELD_PATTERNS,
} from "../src/index.js";

// Parity guard: the inlined SECRET_LIST (legal.ts, bundler-safe) must match the canonical
// src/secret-list.json that the Python scraper reads — else the cross-language scrub silently diverges.
test("inlined secret-list matches the canonical JSON (cross-language single source)", () => {
  const json = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../src/secret-list.json", import.meta.url)), "utf8"),
  ) as { headers: string[]; fieldPatterns: string[] };
  assert.deepEqual([...SECRET_HEADERS], json.headers.map((h) => h.toLowerCase()));
  assert.deepEqual([...SECRET_FIELD_PATTERNS], json.fieldPatterns);
});

// Repo-root fixtures are a CROSS-LANGUAGE golden corpus (Python/Go tests load the same files).
const repoFixture = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

// ── Round-trip: valid fixtures parse ─────────────────────────────────────────
test("CaptureBundle accepts the golden public bundle", () => {
  const parsed = CaptureBundle.parse(repoFixture("capture-bundles/sample-public.json"));
  assert.equal(parsed.source, "scraper");
  assert.equal(parsed.network.length, 1);
  assert.equal(parsed.dom.selectorsOfInterest?.length, 2);
});

// ── Rejection: the schema's real job is to REJECT malformed input ────────────
test("CaptureBundle rejects a missing required field (domHash)", () => {
  const bad = repoFixture("capture-bundles/sample-public.json") as any;
  delete bad.dom.domHash;
  assert.equal(CaptureBundle.safeParse(bad).success, false);
});

test("CaptureBundle rejects an unknown source", () => {
  const bad = repoFixture("capture-bundles/sample-public.json") as any;
  bad.source = "carrier-pigeon";
  assert.equal(CaptureBundle.safeParse(bad).success, false);
});

test("ExecutionStrategy rejects an unknown discriminant kind", () => {
  const r = ExecutionStrategy.safeParse({ kind: "telepathy", steps: [] });
  assert.equal(r.success, false);
});

test("CaptureBundle accepts optional rich page snapshot fields", () => {
  const base = repoFixture("capture-bundles/sample-public.json") as any;
  base.page = {
    visibleText: "hello",
    headings: ["Heading"],
    actions: [{ kind: "button", label: "Search", selector: "button.search" }],
    forms: [{
      selector: "form.search",
      method: "GET",
      purpose: "search",
      fields: [{ name: "q", type: "search", required: true, selector: "input[name=q]" }],
    }],
    appState: [{ source: "__NEXT_DATA__", keys: ["props"], schema: { type: "object" } }],
  };
  assert.equal(CaptureBundle.safeParse(base).success, true);
});

test("ToolDefinition accepts the golden http tool and rejects non-snake_case names", () => {
  const httpTool = repoFixture("tool-definitions/sample-http-tool.json") as any;
  assert.equal(ToolDefinition.safeParse(httpTool).success, true);

  const badName = { ...httpTool, name: "GetProduct" };
  assert.equal(ToolDefinition.safeParse(badName).success, false);
});

test("Job discriminatedUnion parses self_heal and rejects an unknown kind", () => {
  const ok = Job.safeParse({
    kind: "self_heal",
    serverId: "22222222-2222-4222-8222-222222222222",
    toolName: "get_product",
    failure: {
      toolName: "get_product",
      errorClass: "selector_miss",
      detail: "#q not found",
      observedAt: "2026-05-29T12:00:00.000Z",
    },
  });
  assert.equal(ok.success, true);
  assert.equal(Job.safeParse({ kind: "nope" }).success, false);
});

// ── Legal enforcement encoded in the contract (04) ───────────────────────────
test("GenerateRequest blocks full_scrape without acknowledgement", () => {
  assert.equal(
    GenerateRequest.safeParse({ url: "https://x.com", legalMode: "full_scrape" }).success,
    false,
  );
  assert.equal(
    GenerateRequest.safeParse({
      url: "https://x.com",
      legalMode: "full_scrape",
      acknowledgedFullScrape: true,
    }).success,
    true,
  );
  assert.equal(GenerateRequest.safeParse({ url: "https://x.com", legalMode: "safe" }).success, true);
});

test("GenerateRequest accepts a matching extension bundle and rejects a mismatched bundle URL", () => {
  const bundle = {
    ...(repoFixture("capture-bundles/sample-public.json") as any),
    source: "extension",
    url: "https://example.com/products",
    legalMode: "session",
  };
  assert.equal(
    GenerateRequest.safeParse({ url: "https://example.com/products", legalMode: "session", bundle }).success,
    true,
  );
  assert.equal(
    GenerateRequest.safeParse({ url: "https://example.com/other", legalMode: "session", bundle }).success,
    false,
  );
});

// ── Secret-list scrub: no secret header may survive (04) ─────────────────────
test("scrubHeaders strips exactly the secret-list headers/fields (golden fixture)", () => {
  const fx = repoFixture("secret-scrub/headers.json") as {
    input: Record<string, string>;
    expectedKeptKeys: string[];
  };
  const scrubbed = scrubHeaders(fx.input);
  assert.deepEqual(Object.keys(scrubbed).sort(), [...fx.expectedKeptKeys].sort());
  // Belt-and-suspenders: no obviously-secret key survived.
  for (const k of Object.keys(scrubbed)) {
    assert.ok(!/authorization|cookie|api-key|token|session/i.test(k), `leaked secret header: ${k}`);
  }
});

// ── Fail-closed legal backstop: the CONTRACT rejects un-scrubbed secret headers (04) ──
test("NetworkCapture rejects a request carrying a secret-list header", () => {
  const leaky = {
    method: "GET",
    urlPattern: "/api/x",
    rawUrl: "https://example.com/api/x",
    requestHeaders: { accept: "application/json", authorization: "Bearer leak" },
    statusCode: 200,
    contentType: "application/json",
  };
  assert.equal(NetworkCapture.safeParse(leaky).success, false);
  // ...and accepts it once scrubbed.
  const clean = { ...leaky, requestHeaders: scrubHeaders(leaky.requestHeaders) };
  assert.equal(NetworkCapture.safeParse(clean).success, true);
});

// ── Confidence invariant [0,1] + centralized aggregation (01 §5) ─────────────
test("Confidence rejects out-of-range and clampConfidence clamps", () => {
  assert.equal(Confidence.safeParse(1.5).success, false);
  assert.equal(Confidence.safeParse(-0.1).success, false);
  assert.equal(Confidence.safeParse(0.5).success, true);
  assert.equal(clampConfidence(1.5), 1);
  assert.equal(clampConfidence(-0.2), 0);
  assert.equal(clampConfidence(0.4), 0.4);
});

test("aggregateConfidence is the single shared formula (mean, clamped, empty=0)", () => {
  assert.equal(aggregateConfidence([]), 0);
  assert.equal(aggregateConfidence([0.8]), 0.8);
  assert.equal(aggregateConfidence([0.6, 1.0]), 0.8);
  assert.equal(aggregateConfidence([2, 2]), 1); // out-of-range inputs clamped before averaging
});
