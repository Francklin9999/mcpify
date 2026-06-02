import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RegistryEntry, type CaptureBundle, type GeneratedServerArtifact, type GenerateRequest, type ToolDefinition } from "@mcp/types";
import { generate, type GenerateDeps, type InferenceClient } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));
const bundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;
const validTool = repoFixture("tool-definitions/sample-http-tool.json") as ToolDefinition;

function makeDeps(verifyTools?: GenerateDeps["verifyTools"]) {
  const written: { entry?: RegistryEntry; tools?: ToolDefinition[] } = {};
  const inference: InferenceClient = { proposeTools: async () => JSON.stringify([validTool]) };
  const deps: GenerateDeps = {
    scraper: { capture: async () => bundle },
    inference,
    verifyTools,
    persistence: {
      nextServer: async () => ({ serverId: "66666666-6666-4666-8666-666666666666", version: 1 }),
      saveArtifact: async (a: GeneratedServerArtifact) => `artifacts/${a.serverId}/${a.version}.zip`,
      writeRegistry: async (entry, tools) => { RegistryEntry.parse(entry); written.entry = entry; written.tools = tools; },
    },
  };
  return { deps, written };
}

const req: GenerateRequest = { url: "https://example.com/products", legalMode: "safe" };

test("live verification annotates confidence into the generated server", async () => {
  // A verifier that "verified" everything -> floors confidence up to 0.9.
  const { deps, written } = makeDeps(async (tools) => tools.map((t) => ({ ...t, confidence: 0.9 })));
  const outcome = await generate(req, deps);
  assert.ok(written.tools!.every((t) => t.confidence === 0.9), "annotated confidence flows into persisted tools");
  assert.ok(outcome.confidence >= 0.9, "outcome confidence reflects verification");
});

test("a verification failure never blocks generation (best-effort)", async () => {
  const { deps, written } = makeDeps(async () => { throw new Error("network down"); });
  const outcome = await generate(req, deps);
  assert.equal(outcome.status, "active");
  assert.ok(written.tools && written.tools.length >= 1, "still produced a usable server despite verify failure");
});

test("with no verifier injected, behavior is unchanged (backward compatible)", async () => {
  const { deps, written } = makeDeps();
  const outcome = await generate(req, deps);
  assert.equal(outcome.toolCount, written.tools?.length);
});
