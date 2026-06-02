import { Worker, type Job as BullJob } from "bullmq";
import { Job, QUEUE_NAME } from "@mcp/types";
import { generate } from "./generate.js";
import { type InferenceClient } from "./inference.js";
import { selfHeal, type HealClient } from "./self-heal.js";
import { regenerate } from "./regenerate.js";
import { discover } from "./discover.js";
import type { PostgresStore } from "./adapters/postgres.js";
import type { HttpScraper } from "./adapters/scraper-http.js";
import type { GeneratedServerArtifact, ToolDefinition } from "@mcp/types";

export interface WorkerDeps {
  store: PostgresStore;
  scraper: HttpScraper;
  inference: InferenceClient;
  heal: HealClient;
  /** Optional sitemap/robots sub-page discovery, threaded into the generate path. Off when unset (tests). */
  discoverSubPages?: (pageUrl: string) => Promise<ToolDefinition[]>;
}

export interface JobResult {
  status: "done" | "skipped" | "no_op";
  detail?: string;
  result?: GeneratedServerArtifact;
}

/**
 * Process one job (exported for direct testing without a Redis loop). Dispatches by kind; idempotent via
 * processed_jobs (a retry of an already-processed job is skipped). Fail-closed: the payload is parsed
 * through the contract before use, so a malformed message can't crash the worker mid-flight.
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
        { scraper: deps.scraper, inference: deps.inference, persistence: deps.store.forGenerate(jobId), discoverSubPages: deps.discoverSubPages },
      );
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
  }
}

/** Long-running BullMQ worker consuming `mcp:jobs`. Go (monitor) and the web API produce; this consumes. */
export function startWorker(connection: { host: string; port: number }, deps: WorkerDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: BullJob) => processJob(String(job.id), job.data, deps),
    { connection, concurrency: 4 },
  );
}
