import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaptureBundle, DiscoverJob, ToolDefinition } from "@mcp/types";
import { discover } from "../src/discover.js";
import type { InferenceClient } from "../src/inference.js";
import type { CurrentServer } from "../src/self-heal.js";
import type { VersionPersistence, VersionWrite } from "../src/version-write.js";

function netCapture(method: string, urlPattern: string, rawUrl: string) {
  return { method, urlPattern, rawUrl, requestHeaders: { accept: "application/json" }, statusCode: 200, contentType: "application/json" };
}

function bundle(network: ReturnType<typeof netCapture>[]): CaptureBundle {
  return {
    bundleId: "22222222-2222-4222-8222-222222222222",
    source: "extension",
    url: "https://shop.example.com/",
    capturedAt: "2026-05-30T00:00:00.000Z",
    legalMode: "session",
    dom: { html: "<html><body>shop</body></html>", domHash: "sha256:abc" },
    network,
    meta: { renderedWithJs: true, title: "Shop" },
  } as CaptureBundle;
}

function httpTool(name: string, method: string, urlPattern: string, rawUrl: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execution: { kind: "http", request: netCapture(method, urlPattern, rawUrl), paramMapping: {} },
    confidence: 0.7,
  } as ToolDefinition;
}

function fakePersistence() {
  const writes: VersionWrite[] = [];
  let saved = 0;
  const persistence: VersionPersistence = {
    async saveArtifact() {
      saved++;
      return "fs://artifact";
    },
    async writeVersion(w) {
      writes.push(w);
    },
  };
  return { persistence, writes, get saved() { return saved; } };
}

const SERVER_ID = "33333333-3333-4333-8333-333333333333";
function job(b: CaptureBundle, candidates?: ToolDefinition[]): DiscoverJob {
  return { kind: "discover", serverId: SERVER_ID, bundle: b, candidates };
}

test("discover writes a new version when genuinely-new tools are found", async () => {
  const current: CurrentServer = {
    url: "https://shop.example.com/",
    title: "Shop",
    version: 3,
    tools: [httpTool("search_products", "GET", "/s", "https://shop.example.com/s")],
  };
  const client: InferenceClient = {
    async proposeTools() {
      return "[]";
    },
    async proposeMoreTools() {
      return JSON.stringify({ tools: [httpTool("add_to_cart", "POST", "/api/cart", "https://shop.example.com/api/cart")] });
    },
  };
  const persist = fakePersistence();
  const out = await discover(job(bundle([netCapture("POST", "/api/cart", "https://shop.example.com/api/cart")])), current, {
    inference: client,
    persistence: persist.persistence,
  });

  assert.equal(out.discovered, 1);
  assert.equal(out.wroteVersion, true);
  assert.equal(out.version, 4);
  assert.equal(out.toolCount, 2);
  assert.equal(persist.saved, 1);
  assert.equal(persist.writes.length, 1);
  assert.equal(persist.writes[0]!.version, 4);
  assert.equal(persist.writes[0]!.createdBy, "auto");
  assert.deepEqual(persist.writes[0]!.tools.map((t) => t.name), ["search_products", "add_to_cart"]);
});

test("discover MERGES precomputed candidates WITHOUT a second inference (route already paid)", async () => {
  const current: CurrentServer = {
    url: "https://shop.example.com/",
    title: "Shop",
    version: 3,
    tools: [httpTool("search_products", "GET", "/s", "https://shop.example.com/s")],
  };
  let modelCalls = 0;
  const client: InferenceClient = {
    async proposeTools() {
      modelCalls++;
      return "[]";
    },
    async proposeMoreTools() {
      modelCalls++;
      return "[]";
    },
  };
  const persist = fakePersistence();
  const candidates = [
    httpTool("add_to_cart", "POST", "/api/cart", "https://shop.example.com/api/cart"),
    httpTool("search_products", "GET", "/s", "https://shop.example.com/s"), // dup name, dropped by merge
  ];
  const out = await discover(job(bundle([]), candidates), current, { inference: client, persistence: persist.persistence });

  assert.equal(modelCalls, 0, "carrying candidates must NOT trigger a second inference");
  assert.equal(out.discovered, 1);
  assert.equal(out.wroteVersion, true);
  assert.equal(out.version, 4);
  assert.deepEqual(persist.writes[0]!.tools.map((t) => t.name), ["search_products", "add_to_cart"]);
});

test("discover writes NO version when nothing new (no registry churn, no wasted artifact)", async () => {
  const current: CurrentServer = {
    url: "https://shop.example.com/",
    title: "Shop",
    version: 3,
    tools: [httpTool("search_products", "GET", "/s", "https://shop.example.com/s")],
  };
  let modelCalls = 0;
  const client: InferenceClient = {
    async proposeTools() {
      modelCalls++;
      return "[]";
    },
    async proposeMoreTools() {
      modelCalls++;
      return "[]";
    },
  };
  const persist = fakePersistence();
  // the capture only re-hits the already-covered /s endpoint => no delta
  const out = await discover(job(bundle([netCapture("GET", "/s", "https://shop.example.com/s?k=x")])), current, {
    inference: client,
    persistence: persist.persistence,
  });

  assert.equal(out.discovered, 0);
  assert.equal(out.wroteVersion, false);
  assert.equal(out.version, 3, "current version unchanged");
  assert.equal(out.calledModel, false, "no model call when there's no new material");
  assert.equal(modelCalls, 0);
  assert.equal(persist.saved, 0, "no artifact saved");
  assert.equal(persist.writes.length, 0, "no version written");
});
