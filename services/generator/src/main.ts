import { createDb } from "@mcp/db";
import { startWorker } from "./worker.js";
import { startEnqueueServer } from "./enqueue-server.js";
import { PostgresStore } from "./adapters/postgres.js";
import { HttpScraper } from "./adapters/scraper-http.js";
import { FsArtifactStore } from "./adapters/artifact-store.js";
import { makeLLMClients } from "./llm-factory.js";
import { discoverSubPageTools, httpFetchText } from "./sitemap-discovery.js";
import { verifyAndAnnotate, httpProbe } from "./tool-verifier.js";
import type { ToolDefinition } from "@mcp/types";

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
  const discoverSubPages = subPagesOn ? (url: string) => discoverSubPageTools(url, httpFetchText()) : undefined;
  // Live tool verification (closed loop): execute generated tools against the real site and fold the result
  // into confidence (verified boosted, dead/blocked damped - never pruned). OFF by default; opt-in via
  // VERIFY_TOOLS=1, since it makes the generator issue live GET requests to the target site.
  const verifyOn = env("VERIFY_TOOLS", "0") === "1";
  const verifyTools = verifyOn ? async (tools: ToolDefinition[]) => (await verifyAndAnnotate(tools, httpProbe())).tools : undefined;
  const deps = { store, scraper: new HttpScraper(scraperUrl), inference, heal, discoverSubPages, verifyTools };

  const worker = startWorker(connection, deps);
  const { server } = await startEnqueueServer(enqueuePort, connection);
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
