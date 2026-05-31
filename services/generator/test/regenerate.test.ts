import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RegenerateJob, ToolDefinition } from "@mcp/types";
import { regenerate, type CurrentServer, type InferenceClient, type RegenerateDeps, type VersionWrite } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const baseTool = repoFixture("tool-definitions/sample-http-tool.json") as ToolDefinition;
const current: CurrentServer = {
  url: "https://example.com/products",
  title: "Example",
  version: 7,
  tools: [baseTool, { ...baseTool, name: "list_products" }],
};
const job: RegenerateJob = { kind: "regenerate", serverId: "77777777-7777-4777-8777-777777777777", reason: "large_drift" };

function makeDeps(rawInference: string): { deps: RegenerateDeps; written: { write?: VersionWrite } } {
  const written: { write?: VersionWrite } = {};
  const inference: InferenceClient = { proposeTools: async () => rawInference };
  const deps: RegenerateDeps = {
    scraper: { capture: async () => repoFixture("capture-bundles/sample-public.json") },
    inference,
    persistence: {
      saveArtifact: async (a) => `artifacts/${a.serverId}/${a.version}.zip`,
      writeVersion: async (w) => {
        written.write = w;
      },
    },
  };
  return { deps, written };
}

test("regenerate re-parses the EXISTING server and bumps ITS version (live, createdBy=auto)", async () => {
  const { deps, written } = makeDeps(JSON.stringify([baseTool]));
  const outcome = await regenerate(job, current, deps);

  assert.equal(outcome.serverId, job.serverId); // same server, not a new one
  assert.equal(outcome.version, 8); // 7 -> 8
  assert.equal(outcome.status, "active");
  assert.equal(written.write?.createdBy, "auto");
  assert.equal(written.write?.status, "active");
  assert.equal(written.write?.version, 8);
});

test("regenerate with no re-parsed tools still writes a usable version (content-tool floor)", async () => {
  const { deps, written } = makeDeps("not json");
  const outcome = await regenerate(job, current, deps);

  assert.equal(outcome.toolCount, 1);
  assert.equal(written.write?.tools?.[0]?.name, "fetch_page_content");
  assert.equal(outcome.status, "active");
  assert.equal(written.write?.version, 8); // version still bumped on the existing server
});
