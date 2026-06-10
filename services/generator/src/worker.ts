import { Worker, type Job as BullJob } from "bullmq";
import { Job, QUEUE_NAME } from "@mcp/types";
import { generate } from "./generate.js";
import { type InferenceClient } from "./inference.js";
import { selfHeal, type HealClient } from "./self-heal.js";
import { regenerate } from "./regenerate.js";
import { discover } from "./discover.js";
import { deepen } from "./deepen.js";
import type { PostgresStore } from "./adapters/postgres.js";
import type { HttpScraper } from "./adapters/scraper-http.js";
import type { GeneratedServerArtifact, LegalMode, ToolDefinition } from "@mcp/types";
import { generatorWorkerConcurrency } from "./job-defaults.js";

export interface WorkerDeps {
  store: PostgresStore;
  scraper: HttpScraper;
  inference: InferenceClient;
  heal: HealClient;
  /** Optional sitemap/robots sub-page discovery, threaded into the generate AND deepen paths. Off when unset. */
  discoverSubPages?: (pageUrl: string) => Promise<ToolDefinition[]>;
  /** Optional live tool verification, threaded into the generate path. Off when unset (tests). */
  verifyTools?: (tools: ToolDefinition[], pageUrl: string) => Promise<ToolDefinition[]>;
  /** Optional: enqueue one follow-up `deepen` job after a successful generate. A deepen job never enqueues anything. */
  enqueueDeepen?: (job: { serverId: string; url: string; legalMode: LegalMode }) => Promise<void>;
}

export interface JobResult {
  status: "done" | "skipped" | "no_op";
  detail?: string;
  result?: GeneratedServerArtifact;
}

/**
 * Process one job (exported for direct testing). Dispatches by kind; idempotent via processed_jobs;
 * fail-closed (the payload is contract-parsed before use, so a malformed message can't crash the worker).
 */
export async function processJob(jobId: string, payload: unknown, deps: WorkerDeps): Promise<JobResult> {
  const parsed = Job.safeParse(payload);
  if (!parsed.success) return { status: "no_op", detail: "invalid job payload" };
  const job = parsed.data;

  if (await deps.store.isProcessed(jobId)) return { status: "skipped", detail: "already processed" };

  switch (job.kind) {
    case "generate": {
      const outcome = await generate(
        { url: job.url, legalMode: job.legalMode, bundle: job.bundle },
        { scraper: deps.scraper, inference: deps.inference, persistence: deps.store.forGenerate(jobId), discoverSubPages: deps.discoverSubPages, verifyTools: deps.verifyTools },
      );
      // Fire the async tool-maximizing pass once (a tracked follow-up job, never inline). Only for a usable
      // server, and never let an enqueue failure fail the generate. The deepen job won't enqueue anything.
      if (deps.enqueueDeepen && outcome.status === "active" && outcome.toolCount > 0) {
        try {
          await deps.enqueueDeepen({ serverId: outcome.serverId, url: job.url, legalMode: job.legalMode });
        } catch {
          /* best-effort: a failed enqueue must not fail a successful generate */
        }
      }
      return { status: "done", result: outcome.artifact };
    }
    case "regenerate": {
      const current = await deps.store.loadCurrentServer(job.serverId);
      if (!current) return { status: "no_op", detail: "server not found" };
      await regenerate(job, current, {
        scraper: deps.scraper,
        inference: deps.inference,
        persistence: deps.store.forVersion(jobId, "regenerate"),
      });
      return { status: "done" };
    }
    case "self_heal": {
      const current = await deps.store.loadCurrentServer(job.serverId);
      if (!current) return { status: "no_op", detail: "server not found" };
      await selfHeal(job, current, {
        scraper: deps.scraper,
        heal: deps.heal,
        persistence: deps.store.forVersion(jobId, "self_heal"),
      });
      return { status: "done" };
    }
    case "discover": {
      const current = await deps.store.loadCurrentServer(job.serverId);
      if (!current) return { status: "no_op", detail: "server not found" };
      const outcome = await discover(job, current, {
        inference: deps.inference,
        persistence: deps.store.forVersion(jobId, "discover"),
      });
      // Nothing genuinely new: no version written, report it as a no_op.
      return outcome.wroteVersion
        ? { status: "done", detail: `discovered ${outcome.discovered} tool(s) -> v${outcome.version}` }
        : { status: "no_op", detail: "no new tools" };
    }
    case "deepen": {
      // Sub-page tool maximizing. Requires sub-page discovery to be wired (else nothing to capture).
      if (!deps.discoverSubPages) return { status: "no_op", detail: "sub-page discovery disabled" };
      const current = await deps.store.loadCurrentServer(job.serverId);
      if (!current) return { status: "no_op", detail: "server not found" };
      const outcome = await deepen(job, current, {
        inference: deps.inference,
        persistence: deps.store.forVersion(jobId, "deepen"),
        capture: (url, legalMode) => deps.scraper.capture(url, legalMode),
        discoverSubPages: deps.discoverSubPages,
      });
      return outcome.wroteVersion
        ? { status: "done", detail: `deepened +${outcome.discovered} tool(s) from ${outcome.pagesVisited} sub-page(s) -> v${outcome.version}` }
        : { status: "no_op", detail: `no new tools (${outcome.pagesVisited} sub-page(s) visited)` };
    }
  }
}

/** Long-running BullMQ worker consuming `mcp:jobs`. Go (monitor) and the web API produce; this consumes. */
export function startWorker(connection: { host: string; port: number }, deps: WorkerDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: BullJob) => processJob(String(job.id), job.data, deps),
    { connection, concurrency: generatorWorkerConcurrency() },
  );
}
