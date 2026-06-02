import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GeneratedServerArtifact, type CaptureBundle } from "@mcp/types";
import { inferTools, HeuristicInferenceClient, generateServer } from "../src/index.js";

/**
 * End-to-end capstone: run every real-world HTML fixture through the WHOLE pipeline
 * (inferTools -> generateServer) and assert the produced artifact is structurally sound. The headline
 * invariant is PLACEHOLDER CONSISTENCY: every `{param}` that survives into an http path template or a
 * browser navigate URL must be a declared input on that tool - otherwise the tool ships a dead, never-
 * substitutable URL (the class of bug the `%7Bid%7D` repair fixed). This is the strongest "the generated
 * server actually works" check we can make without a live browser.
 */

const corpusDir = fileURLToPath(new URL("../../../../fixtures/real-world-html/", import.meta.url));
const read = (name: string): string => readFileSync(corpusDir + name, "utf8");

const URL_FOR: Record<string, string> = {
  "tier3-amazon-captcha.html": "https://www.amazon.com/s?k=headphones",
  "adversarial-base-href.html": "https://www.example-store.com/listing/page-2",
  "quotes-scroll-rendered.html": "https://quotes.toscrape.com/scroll",
  "books-toscrape.html": "https://books.toscrape.com/",
  "pypi-search.html": "https://pypi.org/search/?q=http",
};

const VALID_TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{?(\w+)\}\}?/g)].map((m) => m[1]!);
}

const htmlFixtures = readdirSync(corpusDir).filter((f) => f.endsWith(".html"));

test("e2e: every corpus page produces a structurally valid, placeholder-consistent server artifact", async () => {
  for (const name of htmlFixtures) {
    const url = URL_FOR[name] ?? "https://corpus.example.com/page";
    const bundle: CaptureBundle = {
      bundleId: "00000000-0000-4000-8000-000000000000",
      source: "scraper",
      url,
      capturedAt: "2026-06-02T00:00:00.000Z",
      legalMode: "safe",
      tier: 1,
      dom: { html: read(name), domHash: "sha256:x" },
      network: [],
      meta: { renderedWithJs: false },
    };
    const { result } = await inferTools(bundle, new HeuristicInferenceClient());
    const artifact = generateServer({
      serverId: "55555555-5555-4555-8555-555555555555",
      version: 1,
      url,
      title: name,
      tools: result.tools,
      browsing: result.tools.some((t) => t.execution.kind === "browser"),
    });

    // 1. The artifact validates against the frozen contract and ships a server entrypoint.
    assert.doesNotThrow(() => GeneratedServerArtifact.parse(artifact), `${name}: artifact off-contract`);
    const server = artifact.files.find((f) => f.path === "server.ts");
    assert.ok(server && server.content.length > 0, `${name}: server.ts present and non-empty`);

    for (const tool of result.tools) {
      assert.match(tool.name, VALID_TOOL_NAME, `${name}: tool name '${tool.name}' not MCP-safe`);
      const schemaKeys = new Set(Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {}));

      if (tool.execution.kind === "http") {
        // 2. Valid, parseable endpoint URL.
        assert.doesNotThrow(() => new URL(tool.execution.kind === "http" ? tool.execution.request.rawUrl : ""), `${name}: '${tool.name}' rawUrl invalid`);
        // 3. Every PATH placeholder is a declared input (a missing one is an unsubstitutable dead URL).
        const pathTemplate = tool.execution.request.urlPattern.split(/[?#]/)[0] ?? "";
        for (const p of placeholders(pathTemplate)) {
          assert.ok(schemaKeys.has(p), `${name}: '${tool.name}' path placeholder {${p}} is not a declared input`);
        }
      } else {
        for (const step of tool.execution.steps) {
          if (typeof step.value !== "string") continue;
          // 4. No percent-encoded placeholder survived into a navigate/fill value.
          assert.ok(!/%7[Bb]/.test(step.value), `${name}: '${tool.name}' step has encoded placeholder: ${step.value}`);
          // 5. Every placeholder in a browser step value is a declared input.
          for (const p of placeholders(step.value)) {
            assert.ok(schemaKeys.has(p), `${name}: '${tool.name}' step placeholder {${p}} is not a declared input`);
          }
        }
      }
    }
  }
});
