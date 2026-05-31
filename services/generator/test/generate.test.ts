import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RegistryEntry, type CaptureBundle, type GeneratedServerArtifact, type GenerateRequest, type ToolDefinition } from "@mcp/types";

type RegistryEntryT = RegistryEntry;
import { generate, type GenerateDeps, type InferenceClient } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const bundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;
const validTool = repoFixture("tool-definitions/sample-http-tool.json");

function makeDeps(rawInference: string): { deps: GenerateDeps; written: { entry?: RegistryEntryT; tools?: ToolDefinition[] } } {
  const written: { entry?: RegistryEntryT; tools?: ToolDefinition[]; artifactUrl?: string } = {};
  const inference: InferenceClient = { proposeTools: async () => rawInference };
  const deps: GenerateDeps = {
    scraper: { capture: async () => bundle },
    inference,
    persistence: {
      nextServer: async () => ({ serverId: "33333333-3333-4333-8333-333333333333", version: 1 }),
      saveArtifact: async (a: GeneratedServerArtifact) => `artifacts/${a.serverId}/${a.version}.zip`,
      writeRegistry: async (entry, tools, artifactUrl) => {
        RegistryEntry.parse(entry); // the row written must satisfy the contract
        written.entry = entry;
        written.tools = tools;
        written.artifactUrl = artifactUrl;
      },
    },
  };
  return { deps, written };
}

const req: GenerateRequest = { url: "https://example.com/products", legalMode: "safe" };

test("happy path: valid tool -> active server, artifact persisted, row written", async () => {
  const { deps, written } = makeDeps(JSON.stringify([validTool]));
  const outcome = await generate(req, deps);

  assert.equal(outcome.status, "active");
  assert.equal(outcome.toolCount, 1);
  assert.equal(written.entry?.status, "active");
  assert.equal(written.entry?.tier, "auto_gen");
  assert.match(outcome.artifact.artifactUrl ?? "", /^artifacts\//);
  assert.ok(outcome.artifact.files.some((f) => f.path === "server.ts"));
});

test("garbage inference -> content-tool floor keeps the server usable (active, low confidence)", async () => {
  // Previously this produced a 0-tool BROKEN server. The content-tool floor now guarantees a usable
  // server from any site; runtime health (broken/degraded) is the monitor's job, not generation's.
  const { deps, written } = makeDeps("garbage not json");
  const outcome = await generate(req, deps);

  assert.equal(outcome.toolCount, 1);
  assert.equal(written.tools?.[0]?.name, "fetch_page_content");
  assert.equal(outcome.status, "active");
  assert.ok(outcome.confidence > 0 && outcome.confidence < 0.6, "content-only server reads as low confidence");
});

test("extension bundle input bypasses server-side scraper re-fetch", async () => {
  const { deps } = makeDeps(JSON.stringify([validTool]));
  let scraped = false;
  deps.scraper = {
    capture: async () => {
      scraped = true;
      return bundle;
    },
  };

  const extensionBundle: CaptureBundle = { ...bundle, source: "extension", legalMode: "session" };
  const outcome = await generate({ url: extensionBundle.url, legalMode: "session", bundle: extensionBundle }, deps);

  assert.equal(scraped, false);
  assert.equal(outcome.status, "active");
  assert.equal(outcome.toolCount, 1);
});
