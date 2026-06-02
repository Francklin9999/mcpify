import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CaptureBundle, GeneratedServerArtifact, ToolDefinition } from "@mcp/types";
import { processJob, type WorkerDeps } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const bundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;
const validTool = repoFixture("tool-definitions/sample-http-tool.json") as ToolDefinition;

test("generate job returns the generated artifact for /api/jobs polling", async () => {
  const deps: WorkerDeps = {
    scraper: { capture: async () => bundle } as any,
    inference: { proposeTools: async () => JSON.stringify([validTool]) },
    heal: { proposeHeal: async () => "{}" } as any,
    store: {
      isProcessed: async () => false,
      forGenerate: () => ({
        nextServer: async () => ({ serverId: "99999999-9999-4999-8999-999999999999", version: 1 }),
        saveArtifact: async (artifact: GeneratedServerArtifact) => `file:///tmp/${artifact.serverId}/${artifact.version}`,
        writeRegistry: async () => undefined,
      }),
    } as any,
  };

  const result = await processJob(
    "job-artifact",
    { kind: "generate", url: "https://example.com/products", legalMode: "safe", requestedBy: "test" },
    deps,
  );

  assert.equal(result.status, "done");
  assert.equal(result.result?.entrypoint, "server.ts");
  assert.ok(result.result?.files.some((file) => file.path === "claude_code_config.json"));
});

// Runaway guard: a successful generate enqueues EXACTLY ONE deepen follow-up; a deepen job enqueues NOTHING.
test("generate enqueues one deepen; deepen never re-enqueues (no runaway)", async () => {
  const enqueued: { serverId: string; url: string }[] = [];
  const base = {
    isProcessed: async () => false,
    forGenerate: () => ({
      nextServer: async () => ({ serverId: "88888888-8888-4888-8888-888888888888", version: 1 }),
      saveArtifact: async () => "file:///tmp/a",
      writeRegistry: async () => undefined,
    }),
    forVersion: () => ({ saveArtifact: async () => "file:///tmp/a", writeVersion: async () => undefined }),
    loadCurrentServer: async () => ({ url: "https://example.com/", title: "X", version: 1, tools: [validTool] }),
  };
  const deps: WorkerDeps = {
    scraper: { capture: async () => bundle } as any,
    inference: { proposeTools: async () => JSON.stringify([validTool]) },
    heal: { proposeHeal: async () => "{}" } as any,
    store: base as any,
    discoverSubPages: async () => [],
    enqueueDeepen: async (j) => { enqueued.push(j); },
  };

  // A generate fires exactly one deepen.
  await processJob("g1", { kind: "generate", url: "https://example.com/products", legalMode: "safe", requestedBy: "test" }, deps);
  assert.equal(enqueued.length, 1, "generate enqueues exactly one deepen");
  assert.equal(enqueued[0]!.url, "https://example.com/products");

  // A deepen job does NOT enqueue anything further (the runaway guard) - enqueued count is unchanged.
  const before = enqueued.length;
  const r = await processJob("d1", { kind: "deepen", serverId: "88888888-8888-4888-8888-888888888888", url: "https://example.com/", legalMode: "safe" }, deps);
  assert.equal(enqueued.length, before, "a deepen job must never enqueue another job");
  assert.ok(r.status === "no_op" || r.status === "done", `deepen handled cleanly: ${r.status}`);
});
