import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SelfHealJob, ToolDefinition } from "@mcp/types";
import { selfHeal, type CurrentServer, type SelfHealDeps, type HealClient, type VersionWrite } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const baseTool = repoFixture("tool-definitions/sample-http-tool.json") as ToolDefinition;
// Two tools: the one that will fail (get_product) and an untouched neighbor (list_products).
const failingTool: ToolDefinition = { ...baseTool, name: "get_product", confidence: 0.4 };
const neighborTool: ToolDefinition = { ...baseTool, name: "list_products", confidence: 0.9 };

const current: CurrentServer = {
  url: "https://example.com/products",
  title: "Example",
  version: 3,
  tools: [failingTool, neighborTool],
};

const job: SelfHealJob = {
  kind: "self_heal",
  serverId: "66666666-6666-4666-8666-666666666666",
  toolName: "get_product",
  failure: { toolName: "get_product", errorClass: "selector_miss", detail: "#q not found", observedAt: "2026-05-29T12:00:00.000Z" },
};

function makeDeps(healRaw: string): { deps: SelfHealDeps; written: { write?: VersionWrite } } {
  const written: { write?: VersionWrite } = {};
  const heal: HealClient = { proposeHeal: async () => healRaw };
  const deps: SelfHealDeps = {
    scraper: { capture: async () => repoFixture("capture-bundles/sample-public.json") },
    heal,
    persistence: {
      saveArtifact: async (a) => `artifacts/${a.serverId}/${a.version}.zip`,
      writeVersion: async (w) => {
        written.write = w;
      },
    },
  };
  return { deps, written };
}

test("heal changes EXACTLY the failing tool and increments the version", async () => {
  // Healed get_product: same name, higher confidence (the repair).
  const healed: ToolDefinition = { ...failingTool, confidence: 0.95 };
  const { deps, written } = makeDeps(JSON.stringify(healed));

  const outcome = await selfHeal(job, current, deps);

  assert.equal(outcome.healed, true);
  assert.equal(outcome.status, "active");
  assert.equal(outcome.version, 4); // 3 -> 4
  assert.equal(written.write?.createdBy, "self_heal");
  // The write makes the new version LIVE: status active + current confidence (A - feature blocker).
  assert.equal(written.write?.status, "active");
  assert.ok(typeof written.write?.lastParsedAt === "string");

  const newTools = written.write!.tools;
  assert.equal(newTools.length, 2);
  const newGetProduct = newTools.find((t) => t.name === "get_product")!;
  const newNeighbor = newTools.find((t) => t.name === "list_products")!;

  // The failing tool changed...
  assert.notDeepEqual(newGetProduct, failingTool);
  assert.equal(newGetProduct.confidence, 0.95);
  // ...and NOTHING else moved.
  assert.deepEqual(newNeighbor, neighborTool);
});

test("heal failure (non-JSON) leaves the server untouched - no new version", async () => {
  const { deps, written } = makeDeps("could not repair {oops");
  const outcome = await selfHeal(job, current, deps);

  assert.equal(outcome.healed, false);
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.version, 3); // unchanged
  assert.equal(written.write, undefined); // no version written
});

test("heal that renames the tool is rejected (can't invent a different tool)", async () => {
  const renamed: ToolDefinition = { ...failingTool, name: "totally_different" };
  const { deps, written } = makeDeps(JSON.stringify(renamed));
  const outcome = await selfHeal(job, current, deps);

  assert.equal(outcome.healed, false);
  assert.equal(written.write, undefined);
});

test("self_heal for an unknown tool name is a no-op", async () => {
  const { deps, written } = makeDeps(JSON.stringify({ ...failingTool, name: "ghost" }));
  const outcome = await selfHeal({ ...job, toolName: "ghost" }, current, deps);
  assert.equal(outcome.healed, false);
  assert.equal(written.write, undefined);
});
