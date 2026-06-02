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
