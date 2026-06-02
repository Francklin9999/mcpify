import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RegistryEntry, type CaptureBundle, type GeneratedServerArtifact, type GenerateRequest, type ToolDefinition } from "@mcp/types";
import { generate, type GenerateDeps, type InferenceClient } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

const bundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;

function makeDeps(rawInference: string, discoverSubPages?: GenerateDeps["discoverSubPages"]) {
  const written: { tools?: ToolDefinition[] } = {};
  const inference: InferenceClient = { proposeTools: async () => rawInference };
  const deps: GenerateDeps = {
    scraper: { capture: async () => bundle },
    inference,
    discoverSubPages,
    persistence: {
      nextServer: async () => ({ serverId: "44444444-4444-4444-8444-444444444444", version: 1 }),
      saveArtifact: async (a: GeneratedServerArtifact) => `artifacts/${a.serverId}/${a.version}.zip`,
      writeRegistry: async (entry, tools) => {
        RegistryEntry.parse(entry);
        written.tools = tools;
      },
    },
  };
  return { deps, written };
}

const req: GenerateRequest = { url: "https://example.com/products", legalMode: "safe" };

const subPageTool: ToolDefinition = {
  name: "get_project_page",
  description: "Fetch a project detail page by project (from the site's sitemap).",
  inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern: "/project/{project}", rawUrl: "https://example.com/project/x", requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" },
    paramMapping: { project: { in: "path", key: "project" } },
  },
  confidence: 0.6,
};

test("sub-page tools from the injected discoverer are merged into the generated server", async () => {
  const { deps, written } = makeDeps("garbage not json", async () => [subPageTool]);
  const outcome = await generate(req, deps);
  assert.ok(written.tools?.some((t) => t.name === "get_project_page"), "sitemap tool merged");
  assert.ok(written.tools?.some((t) => t.name === "fetch_page_content"), "content floor still present");
  assert.ok(outcome.toolCount >= 2);
});

test("a sub-page tool duplicating an existing endpoint is deduped (no double tool)", async () => {
  // Inference already produced get_project_page; the sitemap proposes the same endpoint -> dropped.
  const { deps, written } = makeDeps(JSON.stringify([subPageTool]), async () => [subPageTool]);
  await generate(req, deps);
  const count = written.tools?.filter((t) => t.execution.kind === "http" && t.execution.request.urlPattern === "/project/{project}").length;
  assert.equal(count, 1, "endpoint appears exactly once");
});

test("sub-page discovery failure never blocks generation", async () => {
  const { deps, written } = makeDeps(JSON.stringify([subPageTool]), async () => {
    throw new Error("network down");
  });
  const outcome = await generate(req, deps);
  assert.equal(outcome.status, "active");
  assert.ok(written.tools && written.tools.length >= 1, "still produced a usable server");
});

test("with no discoverer injected, behavior is unchanged (backward compatible)", async () => {
  const { deps, written } = makeDeps(JSON.stringify([subPageTool]));
  const outcome = await generate(req, deps);
  assert.equal(outcome.toolCount, written.tools?.length);
  assert.ok(written.tools?.some((t) => t.name === "get_project_page"));
});
