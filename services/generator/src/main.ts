import { createDb } from "@mcp/db";
import { startWorker } from "./worker.js";
import { startEnqueueServer } from "./enqueue-server.js";
import { PostgresStore } from "./adapters/postgres.js";
import { HttpScraper } from "./adapters/scraper-http.js";
import { FsArtifactStore } from "./adapters/artifact-store.js";
import { OpenAIInferenceClient, OpenAIHealClient } from "./openai-client.js";
import { HeuristicInferenceClient, HeuristicHealClient } from "./heuristic-inference.js";
import type { InferenceClient } from "./inference.js";
import type { HealClient } from "./self-heal.js";

/**
 * Deployable worker process: consumes `mcp-jobs` (BullMQ) and runs the enqueue shim for the Go monitor.
 * Without it, jobs enqueued by the web/monitor are never consumed. Env:
 *   DATABASE_URL, REDIS_URL, SCRAPER_URL, ARTIFACT_ROOT, ENQUEUE_PORT, [OPENAI_API_KEY], [OPENAI_MODEL]
 * With no OPENAI_API_KEY it falls back to the keyless heuristic inference (real servers, lower confidence).
 */
function env(key: string, def: string): string {
  return process.env[key] ?? def;
}

async function main(): Promise<void> {
  const databaseUrl = env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/mcp");
  const redisUrl = new URL(env("REDIS_URL", "redis://127.0.0.1:6379"));
  const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };
  const scraperUrl = env("SCRAPER_URL", "http://127.0.0.1:8000");
  const artifactRoot = env("ARTIFACT_ROOT", "/tmp/mcp-artifacts");
  const enqueuePort = Number(env("ENQUEUE_PORT", "8081"));

  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const inference: InferenceClient = hasKey ? new OpenAIInferenceClient() : new HeuristicInferenceClient();
  const heal: HealClient = hasKey ? new OpenAIHealClient() : new HeuristicHealClient();
  if (hasKey) console.log(`[worker] OPENAI_API_KEY set — using OpenAI inference (model=${process.env.OPENAI_MODEL ?? "gpt-4o"})`);
  else console.warn("[worker] OPENAI_API_KEY not set — using keyless heuristic inference");

  const store = new PostgresStore(createDb(databaseUrl), new FsArtifactStore(artifactRoot));
  const deps = { store, scraper: new HttpScraper(scraperUrl), inference, heal };

  const worker = startWorker(connection, deps);
  const { server } = startEnqueueServer(enqueuePort, connection);
  console.log(`[worker] consuming mcp-jobs; enqueue shim on :${enqueuePort}; scraper=${scraperUrl}; artifacts=${artifactRoot}`);

  const shutdown = async () => {
    await worker.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
