import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CaptureBundle, DeepenJob, GeneratedServerArtifact, ToolDefinition } from "@mcp/types";
import { deepen, type DeepenDeps } from "../src/deepen.js";
import type { CurrentServer } from "../src/self-heal.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));
const baseBundle = repoFixture("capture-bundles/sample-public.json") as CaptureBundle;
const sampleTool = repoFixture("tool-definitions/sample-http-tool.json") as ToolDefinition;

const ORIGIN = "https://site.example";

// A sub-page "tool" from sitemap discovery (only its rawUrl matters - that's what deepen captures).
function subTool(path: string, origin = ORIGIN): ToolDefinition {
  return {
    name: `get_${path.replace(/\W+/g, "_")}_page`,
    description: `detail ${path}`,
    inputSchema: { type: "object", properties: {} },
    execution: { kind: "http", request: { method: "GET", urlPattern: path, rawUrl: `${origin}${path}`, requestHeaders: {}, statusCode: 200, contentType: "text/html" }, paramMapping: {} },
    confidence: 0.6,
  } as ToolDefinition;
}

// A captured sub-page bundle whose distinct network XHR makes computeDelta report hasNew=true.
function bundleFor(url: string, n: number): CaptureBundle {
  return {
    ...baseBundle,
    url,
    network: [{ method: "GET", urlPattern: `/xhr/${n}`, rawUrl: `${ORIGIN}/xhr/${n}`, requestHeaders: {}, statusCode: 200, contentType: "application/json" }],
    meta: { ...baseBundle.meta, renderedWithJs: false },
  } as CaptureBundle;
}

// Counting fake inference: each call proposes ONE distinct new tool, so accumulation is observable.
function countingInference() {
  let n = 0;
  return {
    calls: () => n,
    proposeTools: async (_b: CaptureBundle) => {
      n++;
      return JSON.stringify([{
        name: `mined_tool_${n}`,
        description: `mined ${n}`,
        inputSchema: { type: "object", properties: {} },
        execution: { kind: "http", request: { method: "GET", urlPattern: `/mined/${n}`, rawUrl: `${ORIGIN}/mined/${n}`, requestHeaders: {}, statusCode: 200, contentType: "text/html" }, paramMapping: {} },
        confidence: 0.7,
      }]);
    },
  };
}

function recordingPersistence() {
  const versions: { version: number; tools: ToolDefinition[] }[] = [];
  return {
    versions,
    saveArtifact: async (_a: GeneratedServerArtifact) => "file:///tmp/x",
    writeVersion: async (v: any) => { versions.push({ version: v.version, tools: v.tools }); },
  };
}

const current: CurrentServer = { url: ORIGIN + "/", title: "Site", version: 1, tools: [sampleTool] };
const job: DeepenJob = { kind: "deepen", serverId: "33333333-3333-4333-8333-333333333333", url: ORIGIN + "/", legalMode: "safe" };

test("deepen captures sub-pages SEQUENTIALLY and accumulates into exactly ONE new version", async () => {
  const inference = countingInference();
  const persistence = recordingPersistence();
  const captured: string[] = [];
  const deps: DeepenDeps = {
    inference,
    persistence: persistence as any,
    capture: async (url) => { captured.push(url); return bundleFor(url, captured.length); },
    discoverSubPages: async () => [subTool("/a/1"), subTool("/b/2")],
  };

  const out = await deepen(job, current, deps);

  assert.equal(out.pagesVisited, 2, "captured both sub-pages");
  assert.equal(inference.calls(), 2, "ran incremental discovery once per sub-page (sequential)");
  assert.equal(out.discovered, 2, "two distinct new tools added");
  assert.equal(out.wroteVersion, true);
  assert.equal(out.version, 2, "exactly one version bump");
  assert.equal(persistence.versions.length, 1, "ONE version write, not one-per-page (no race/fragmentation)");
  // The single written version ACCUMULATES: base tool + both mined tools, deduped.
  const names = persistence.versions[0]!.tools.map((t) => t.name).sort();
  assert.ok(names.includes("mined_tool_1") && names.includes("mined_tool_2"), `both mined tools present: ${names.join(",")}`);
  assert.ok(names.includes(sampleTool.name), "the original tool is preserved");
});

test("deepen is bounded: at most maxPages sub-pages are captured", async () => {
  const inference = countingInference();
  const persistence = recordingPersistence();
  let captures = 0;
  const deps: DeepenDeps = {
    inference,
    persistence: persistence as any,
    maxPages: 3,
    capture: async (url) => { captures++; return bundleFor(url, captures); },
    discoverSubPages: async () => [subTool("/a/1"), subTool("/b/2"), subTool("/c/3"), subTool("/d/4"), subTool("/e/5")],
  };
  await deepen(job, current, deps);
  assert.equal(captures, 3, "never captures more than maxPages, even with 5 sub-page families");
});

test("deepen never wanders off-origin", async () => {
  const persistence = recordingPersistence();
  const captured: string[] = [];
  const deps: DeepenDeps = {
    inference: countingInference(),
    persistence: persistence as any,
    capture: async (url) => { captured.push(url); return bundleFor(url, captured.length); },
    discoverSubPages: async () => [subTool("/ok/1"), subTool("/evil/1", "https://other.example")],
  };
  await deepen(job, current, deps);
  assert.ok(captured.every((u) => new URL(u).origin === ORIGIN), `only on-origin captures: ${captured.join(",")}`);
  assert.equal(captured.length, 1, "the off-origin sub-page was skipped");
});

test("deepen writes NO version when nothing new is found (no churn)", async () => {
  const persistence = recordingPersistence();
  const deps: DeepenDeps = {
    inference: countingInference(),
    persistence: persistence as any,
    capture: async (url) => bundleFor(url, 1),
    discoverSubPages: async () => [], // no sub-pages -> nothing to do
  };
  const out = await deepen(job, current, deps);
  assert.equal(out.wroteVersion, false);
  assert.equal(out.pagesVisited, 0);
  assert.equal(persistence.versions.length, 0, "no version written");
});
