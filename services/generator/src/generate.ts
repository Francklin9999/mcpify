import type { CaptureBundle, GenerateRequest, GeneratedServerArtifact, LegalMode, RegistryEntry, ToolDefinition } from "@mcp/types";
import { aggregateConfidence } from "@mcp/types";
import { inferTools, validateCandidates, type InferenceClient } from "./inference.js";
import { coverageOf, toolSig } from "./incremental.js";
import { generateServer } from "./codegen.js";

/**
 * `generate` use-case (`03` Flow A): scraper -> inference -> codegen -> persist.
 * scraper + persistence are PORTS so this orchestrator builds and tests with zero live services.
 * Real BullMQ consumer, scraper HTTP call, Postgres + R2 wiring are the next unit (Phase 2).
 */
export interface Scraper {
  capture(url: string, legalMode: LegalMode): Promise<CaptureBundle>;
}

export interface GeneratePersistence {
  /** Allocate the next (serverId, version) for a URL (idempotent per `03`). */
  nextServer(url: string): Promise<{ serverId: string; version: number }>;
  /** Persist the artifact (e.g. R2) and return its URL. */
  saveArtifact(artifact: GeneratedServerArtifact): Promise<string>;
  /** Write the registry row + the first version's tools (atomically). `artifactUrl` is the saved location. */
  writeRegistry(entry: RegistryEntry, tools: ToolDefinition[], artifactUrl: string): Promise<void>;
}

export interface GenerateDeps {
  scraper: Scraper;
  inference: InferenceClient;
  persistence: GeneratePersistence;
  /**
   * Optional sub-page discovery (sitemap/robots). When provided, its tools are merged into the inferred set
   * (deduped by name + endpoint signature). Best-effort: a failure or absence never blocks generation.
   */
  discoverSubPages?: (pageUrl: string) => Promise<ToolDefinition[]>;
}

export interface GenerateOutcome {
  serverId: string;
  version: number;
  status: RegistryEntry["status"];
  toolCount: number;
  droppedCount: number;
  confidence: number;
  artifact: GeneratedServerArtifact;
}

export async function generate(req: GenerateRequest, deps: GenerateDeps): Promise<GenerateOutcome> {
  const bundle = req.bundle ?? (await deps.scraper.capture(req.url, req.legalMode));
  const { result, droppedCount } = await inferTools(bundle, deps.inference);

  // Best-effort sub-page enrichment: fold in tools discovered from the site's own sitemap/robots, deduped
  // by name + endpoint signature so they never duplicate DOM-mined detail tools. Never blocks generation.
  const tools = await withSubPageTools(result.tools, req.url, deps.discoverSubPages);
  const confidence = tools === result.tools ? result.confidence : aggregateConfidence(tools.map((t) => t.confidence));

  const { serverId, version } = await deps.persistence.nextServer(req.url);
  const title = bundle.meta.title ?? req.url;
  // Emit the snapshot-driven browsing toolkit (browser_navigate/click/type/...) when the page is
  // interactive - JS-rendered, has on-page actions/forms, or inference already produced a browser tool.
  // This is what lets an LLM drive the page turn-by-turn (paginate, add to cart, multi-step flows).
  const browsing =
    bundle.meta.renderedWithJs ||
    (bundle.page?.actions?.length ?? 0) > 0 ||
    (bundle.page?.forms?.length ?? 0) > 0 ||
    tools.some((t) => t.execution.kind === "browser");
  const artifact = generateServer({ serverId, version, url: req.url, title, tools, browsing });

  // A server with zero usable tools is NOT active - surface it as broken (per generator.md), not a
  // healthy zero-tool server. Confidence is already 0 in that case (aggregateConfidence([]) === 0).
  const status: RegistryEntry["status"] = tools.length === 0 ? "broken" : "active";

  const artifactUrl = await deps.persistence.saveArtifact(artifact);
  const entry: RegistryEntry = {
    serverId,
    url: req.url,
    title,
    tier: "auto_gen",
    confidence,
    installCount: 0,
    lastParsedAt: new Date().toISOString(),
    status,
    currentVersion: version,
  };
  await deps.persistence.writeRegistry(entry, tools, artifactUrl);

  return {
    serverId,
    version,
    status,
    toolCount: tools.length,
    droppedCount,
    confidence,
    artifact: { ...artifact, artifactUrl },
  };
}

/**
 * Merge sitemap/robots-discovered sub-page tools into the inferred set. Deduped by tool name AND endpoint
 * signature (so a sitemap `get_product_page` never duplicates a DOM-mined one). Returns the SAME array when
 * nothing is added (so callers can skip a confidence recompute). Best-effort: any failure yields the inputs.
 */
async function withSubPageTools(
  tools: ToolDefinition[],
  pageUrl: string,
  discover?: (pageUrl: string) => Promise<ToolDefinition[]>,
): Promise<ToolDefinition[]> {
  if (!discover) return tools;
  try {
    const extra = await discover(pageUrl);
    if (!extra.length) return tools;
    const coverage = coverageOf(tools);
    const { tools: merged } = validateCandidates(extra, {
      seenNames: coverage.names,
      dropIf: (tool) => {
        const s = toolSig(tool);
        return s !== "" && coverage.sigs.has(s);
      },
    });
    return merged.length ? [...tools, ...merged] : tools;
  } catch {
    return tools; // sub-page discovery is best-effort; a failure must never block generation
  }
}
