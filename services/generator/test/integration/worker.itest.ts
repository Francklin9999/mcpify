/**
 * Worker integration test — the REAL bar: real Redis + Postgres, assert on actual rows.
 * Run via test/integration/run.sh (boots Docker pg+redis, applies the migration, sets env).
 * Inference + scraper are in-process fakes (no live Claude / no Python subprocess — that seam is the
 * separate scraper-seam check). This proves the persistence heart: transactional multi-table writes,
 * current_version repointing, and job-keyed idempotency under at-least-once delivery.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, servers, serverVersions, tools as toolsTable, processedJobs } from "@mcp/db";
import { CaptureBundle, QUEUE_NAME, type GenerateJob, type SelfHealJob } from "@mcp/types";
import { PostgresStore, FsArtifactStore, processJob, startWorker, type WorkerDeps } from "../../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

function one<T>(rows: T[]): T {
  assert.ok(rows[0], "expected at least one row");
  return rows[0];
}

const DATABASE_URL = process.env.DATABASE_URL!;
const REDIS = { host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379) };

const bundle = CaptureBundle.parse(repoFixture("capture-bundles/sample-public.json"));
const validTool = repoFixture("tool-definitions/sample-http-tool.json");

const fakeScraper = { capture: async () => bundle };
const fakeInference = { proposeTools: async () => JSON.stringify([validTool, { ...validTool, name: "list_products" }]) };
const fakeHeal = { proposeHeal: async () => JSON.stringify({ ...validTool, name: "get_product", confidence: 0.99 }) };

let db: ReturnType<typeof createDb>;
let deps: WorkerDeps;

before(() => {
  db = createDb(DATABASE_URL);
  const store = new PostgresStore(db, new FsArtifactStore(mkdtempSync(join(tmpdir(), "art-"))));
  deps = { store, scraper: fakeScraper as any, inference: fakeInference, heal: fakeHeal as any };
});

after(async () => {
  await (db as any).$client?.end?.();
});

test("generate writes real, atomic rows and points the server at v1", async () => {
  const url = "https://itest.example.com/a";
  const job: GenerateJob = { kind: "generate", url, legalMode: "safe", requestedBy: "itest" };
  const res = await processJob("job-gen-a", job, deps);
  assert.equal(res.status, "done");

  const srv = one(await db.select().from(servers).where(eq(servers.url, url)));
  assert.equal(srv.status, "active");
  assert.equal(srv.currentVersion, 1);

  const versions = await db.select().from(serverVersions).where(eq(serverVersions.serverId, srv.serverId));
  assert.equal(versions.length, 1);
  assert.match(versions[0]!.artifactUrl, /^file:\/\//); // real saved artifact, not the pending placeholder
  assert.equal(versions[0]!.toolCount, 2);

  const toolRows = await db.select().from(toolsTable).where(eq(toolsTable.serverId, srv.serverId));
  assert.deepEqual(toolRows.map((t) => t.name).sort(), ["get_product", "list_products"]);
  assert.equal(toolRows.find((t) => t.name === "get_product")!.executionKind, "http");

  const pj = await db.select().from(processedJobs).where(eq(processedJobs.jobId, "job-gen-a"));
  assert.equal(pj.length, 1);
});

test("idempotent: reprocessing the same jobId is skipped — no duplicate version", async () => {
  const url = "https://itest.example.com/idem";
  const job: GenerateJob = { kind: "generate", url, legalMode: "safe", requestedBy: "itest" };
  const first = await processJob("job-idem", job, deps);
  const second = await processJob("job-idem", job, deps);
  assert.equal(first.status, "done");
  assert.equal(second.status, "skipped");

  const srv = one(await db.select().from(servers).where(eq(servers.url, url)));
  const versions = await db.select().from(serverVersions).where(eq(serverVersions.serverId, srv.serverId));
  assert.equal(versions.length, 1, "no duplicate version from the retry");
});

test("generating the SAME url twice (different jobs) upserts — bumps version, no FK crash", async () => {
  // Regression: nextServer used to mint a new serverId + v1 every time; on a known url the servers insert
  // was skipped (onConflictDoNothing) and the server_versions FK insert then crashed the job.
  const url = "https://itest.example.com/twice";
  await processJob("twice-1", { kind: "generate", url, legalMode: "safe", requestedBy: "i" }, deps);
  const after1 = one(await db.select().from(servers).where(eq(servers.url, url)));
  assert.equal(after1.currentVersion, 1);

  const res2 = await processJob("twice-2", { kind: "generate", url, legalMode: "safe", requestedBy: "i" }, deps);
  assert.equal(res2.status, "done", "second generate of the same url must succeed, not FK-crash");

  const after2 = one(await db.select().from(servers).where(eq(servers.url, url)));
  assert.equal(after2.serverId, after1.serverId, "same server row reused, not an orphan");
  assert.equal(after2.currentVersion, 2, "version bumped on the existing server");
  const versions = await db.select().from(serverVersions).where(eq(serverVersions.serverId, after1.serverId));
  assert.equal(versions.length, 2, "two versions on the one server");
});

test("self_heal bumps the version, repoints current_version, changes only the failing tool", async () => {
  const url = "https://itest.example.com/heal";
  await processJob("job-heal-gen", { kind: "generate", url, legalMode: "safe", requestedBy: "itest" }, deps);
  const srv = one(await db.select().from(servers).where(eq(servers.url, url)));
  assert.equal(srv.currentVersion, 1);

  const healJob: SelfHealJob = {
    kind: "self_heal",
    serverId: srv.serverId,
    toolName: "get_product",
    failure: { toolName: "get_product", errorClass: "selector_miss", detail: "x", observedAt: new Date().toISOString() },
  };
  const res = await processJob("job-heal-1", healJob, deps);
  assert.equal(res.status, "done");

  const srv2 = one(await db.select().from(servers).where(eq(servers.serverId, srv.serverId)));
  assert.equal(srv2.currentVersion, 2, "current_version repointed to the healed version (it went LIVE)");
  assert.equal(srv2.status, "active");

  const v2tools = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.serverId, srv.serverId));
  const v2 = v2tools.filter((t) => t.version === 2);
  assert.equal(v2.length, 2);
  const healed = v2.find((t) => t.name === "get_product")!;
  const neighbor = v2.find((t) => t.name === "list_products")!;
  assert.equal(healed.confidence, 0.99, "the failing tool was rewritten");
  assert.equal(neighbor.confidence, validTool.confidence, "the neighbor is unchanged");
});

test("self_heal idempotency: a retried heal job does not mint v3", async () => {
  const url = "https://itest.example.com/heal2";
  await processJob("job-h2-gen", { kind: "generate", url, legalMode: "safe", requestedBy: "itest" }, deps);
  const srv = one(await db.select().from(servers).where(eq(servers.url, url)));
  const healJob: SelfHealJob = {
    kind: "self_heal",
    serverId: srv.serverId,
    toolName: "get_product",
    failure: { toolName: "get_product", errorClass: "selector_miss", detail: "x", observedAt: new Date().toISOString() },
  };
  await processJob("job-h2-heal", healJob, deps);
  await processJob("job-h2-heal", healJob, deps); // retry, same jobId

  const srv2 = one(await db.select().from(servers).where(eq(servers.serverId, srv.serverId)));
  assert.equal(srv2.currentVersion, 2, "retry did not bump to v3");
});

test("full BullMQ round-trip: enqueue -> worker -> real row", async () => {
  const url = "https://itest.example.com/queue";
  const queue = new Queue(QUEUE_NAME, { connection: REDIS });
  const worker = startWorker(REDIS, deps);
  try {
    await queue.add("generate", { kind: "generate", url, legalMode: "safe", requestedBy: "q" } as GenerateJob);
    // Poll for the row the worker should write.
    let srv: any;
    for (let i = 0; i < 50; i++) {
      [srv] = await db.select().from(servers).where(eq(servers.url, url));
      if (srv) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(srv, "worker processed the enqueued job and wrote the server row");
    assert.equal(srv.status, "active");
  } finally {
    await worker.close();
    await queue.close();
  }
});
