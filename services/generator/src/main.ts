import { createDb } from "@mcp/db";
import { startWorker } from "./worker.js";
import { startEnqueueServer } from "./enqueue-server.js";
import { PostgresStore } from "./adapters/postgres.js";
import { HttpScraper } from "./adapters/scraper-http.js";
import { FsArtifactStore } from "./adapters/artifact-store.js";
import { makeLLMClients } from "./llm-factory.js";
import { discoverSubPageTools, httpFetchText } from "./sitemap-discovery.js";
import { discoverApiSpecTools } from "./api-spec.js";
import { verifyAndAnnotate, httpProbe } from "./tool-verifier.js";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { QUEUE_NAME, type LegalMode, type ToolDefinition } from "@mcp/types";
import { defaultQueueOptions } from "./job-defaults.js";

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
  // Bind the platform-injected $PORT when present (Railway/Render/Fly), else ENQUEUE_PORT, else 8081.
  const enqueuePort = Number(env("ENQUEUE_PORT", env("PORT", "8081")));

  const { inference, heal } = makeLLMClients();

  const store = new PostgresStore(createDb(databaseUrl), new FsArtifactStore(artifactRoot));
  // Sub-page discovery (sitemap/robots) enriches generated servers with parameterized detail tools so a
  // single link yields as many tools as the site exposes. ON by default; set SUBPAGE_DISCOVERY=0 to disable.
  // It fetches /robots.txt + /sitemap.xml directly (honoring Disallow) rather than routing through the
  // scraper's centralized legal layer - a deliberate posture choice. Best-effort + bounded; never blocks a job.
  const subPagesOn = env("SUBPAGE_DISCOVERY", "1") !== "0";
  // API-contract ingestion (OpenAPI/Swagger/GraphQL): a site that publishes a machine-readable contract yields
  // a complete, correctly-typed tool surface - far higher quality than DOM-mining one page. ON by default;
  // set API_SPEC_DISCOVERY=0 to disable. Composed with sitemap discovery into the SINGLE discoverSubPages hook
  // (generate.ts dedups the merged set by name + endpoint signature). API tools go first (higher confidence).
  const apiSpecOn = env("API_SPEC_DISCOVERY", "1") !== "0";
  const discoverSubPages =
    subPagesOn || apiSpecOn
      ? async (url: string): Promise<ToolDefinition[]> => {
          const [api, sub] = await Promise.all([
            apiSpecOn ? discoverApiSpecTools(url, httpFetchText()).catch(() => [] as ToolDefinition[]) : Promise.resolve([] as ToolDefinition[]),
            subPagesOn ? discoverSubPageTools(url, httpFetchText()).catch(() => [] as ToolDefinition[]) : Promise.resolve([] as ToolDefinition[]),
          ]);
          return [...api, ...sub];
        }
      : undefined;
  // Live tool verification (closed loop): execute generated tools against the real site and fold the result
  // into confidence (verified boosted, dead/blocked damped - never pruned). OFF by default; opt-in via
  // VERIFY_TOOLS=1, since it makes the generator issue live GET requests to the target site.
  const verifyOn = env("VERIFY_TOOLS", "0") === "1";
  const verifyTools = verifyOn ? async (tools: ToolDefinition[]) => (await verifyAndAnnotate(tools, httpProbe())).tools : undefined;
  // Deepen pass: after a generate, enqueue ONE follow-up job that captures a few sub-pages and mines them for
  // more tools. OPT-IN via DEEPEN_DISCOVERY=1: measured added-tool yield over representative same-site page
  // pairs (with the keyless heuristic) is ~0 - discoverMore's name+sig dedup eats the re-mined structural
  // patterns - while it costs ~3 extra sub-page captures + 3 inference passes per generate. Enable it when
  // using a strong LLM inference client (which may extract page-specific tools the heuristic can't), or for
  // sites with genuinely distinct sub-page types. Uses a producer Queue; the deepen job never re-enqueues.
  const deepenOn = subPagesOn && env("DEEPEN_DISCOVERY", "0") === "1";
  const producerQueue = deepenOn ? new Queue(QUEUE_NAME, defaultQueueOptions(connection)) : undefined;
  const enqueueDeepen = producerQueue
    ? async (j: { serverId: string; url: string; legalMode: LegalMode }) => {
        await producerQueue.add("deepen", { kind: "deepen", ...j }, { jobId: randomUUID() });
      }
    : undefined;
  const deps = { store, scraper: new HttpScraper(scraperUrl), inference, heal, discoverSubPages, verifyTools, enqueueDeepen };

  const worker = startWorker(connection, deps);
  const { server } = await startEnqueueServer(enqueuePort, connection);
  console.log(`[worker] consuming mcp-jobs; enqueue shim on :${enqueuePort}; scraper=${scraperUrl}; artifacts=${artifactRoot}`);

  const shutdown = async () => {
    await worker.close();
    if (producerQueue) await producerQueue.close();
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
