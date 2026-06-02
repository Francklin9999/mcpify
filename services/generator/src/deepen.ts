import { aggregateConfidence, type DeepenJob, type CaptureBundle, type LegalMode, type ToolDefinition } from "@mcp/types";
import { generateServer } from "./codegen.js";
import { discoverMore } from "./incremental.js";
import type { InferenceClient } from "./inference.js";
import type { CurrentServer } from "./self-heal.js";
import type { VersionPersistence } from "./version-write.js";

/**
 * `deepen` handler - maximizes the tools a single link yields. After a server is generated, this captures a
 * bounded sample of the site's sub-pages (concrete example URLs from sitemap discovery) and runs INCREMENTAL
 * discovery over them, ACCUMULATING into one toolset so each pass dedupes against the previous one, then
 * writes exactly ONE new version. Sequential by design: N parallel jobs would each read the same base and
 * their merges wouldn't compose (and would collide on the version PK). Bounded, best-effort, and it NEVER
 * enqueues another job (runaway-safe). No-ops (no version) when nothing new surfaces.
 */
export interface DeepenDeps {
  inference: InferenceClient;
  persistence: VersionPersistence;
  /** Capture a sub-page (the same scraper the generate path uses). */
  capture: (url: string, legalMode: LegalMode) => Promise<CaptureBundle>;
  /** Discover the site's sub-page tools (their example URLs are what we capture). */
  discoverSubPages: (pageUrl: string) => Promise<ToolDefinition[]>;
  /** Max sub-pages to capture (cost bound). Default 3. */
  maxPages?: number;
}

export interface DeepenOutcome {
  serverId: string;
  discovered: number;
  version: number;
  wroteVersion: boolean;
  toolCount: number;
  /** how many sub-pages were actually captured. */
  pagesVisited: number;
}

/** Concrete example URLs to capture, taken from the sitemap-discovered tools (one per detail family). */
function sampleUrls(subTools: ToolDefinition[], origin: string, max: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const tool of subTools) {
    if (tool.execution.kind !== "http") continue;
    const raw = tool.execution.request.rawUrl;
    if (!raw || seen.has(raw)) continue;
    try {
      if (new URL(raw).origin !== origin) continue; // never wander off-site
    } catch {
      continue;
    }
    seen.add(raw);
    urls.push(raw);
    if (urls.length >= max) break;
  }
  return urls;
}

export async function deepen(job: DeepenJob, current: CurrentServer, deps: DeepenDeps): Promise<DeepenOutcome> {
  const maxPages = deps.maxPages ?? 3;
  const noChange: DeepenOutcome = {
    serverId: job.serverId,
    discovered: 0,
    version: current.version,
    wroteVersion: false,
    toolCount: current.tools.length,
    pagesVisited: 0,
  };

  let origin: string;
  try {
    origin = new URL(job.url).origin;
  } catch {
    return noChange;
  }

  // Best-effort: a discovery/capture failure must never fail the job or churn a version.
  let subTools: ToolDefinition[] = [];
  try {
    subTools = await deps.discoverSubPages(job.url);
  } catch {
    return noChange;
  }
  const urls = sampleUrls(subTools, origin, maxPages);
  if (urls.length === 0) return noChange;

  // Accumulate SEQUENTIALLY: each pass dedupes against the growing toolset (this is why it's one job).
  let tools = current.tools;
  const added: ToolDefinition[] = [];
  let pagesVisited = 0;
  for (const url of urls) {
    let bundle: CaptureBundle;
    try {
      bundle = await deps.capture(url, job.legalMode);
    } catch {
      continue; // skip a sub-page that fails to capture
    }
    pagesVisited++;
    try {
      const out = await discoverMore(tools, bundle, deps.inference);
      tools = out.tools;
      added.push(...out.added);
    } catch {
      /* a single bad pass never aborts the deepen */
    }
  }

  if (added.length === 0) {
    return { ...noChange, pagesVisited };
  }

  const newVersion = current.version + 1;
  const artifact = generateServer({
    serverId: job.serverId,
    version: newVersion,
    url: current.url,
    title: current.title,
    tools,
    browsing: tools.some((t) => t.execution.kind === "browser"),
  });
  const artifactUrl = await deps.persistence.saveArtifact(artifact);
  await deps.persistence.writeVersion({
    serverId: job.serverId,
    version: newVersion,
    tools,
    confidence: aggregateConfidence(tools.map((t) => t.confidence)),
    artifactUrl,
    createdBy: "auto",
    status: "active",
    lastParsedAt: new Date().toISOString(),
  });

  return {
    serverId: job.serverId,
    discovered: added.length,
    version: newVersion,
    wroteVersion: true,
    toolCount: tools.length,
    pagesVisited,
  };
}
