import type { CaptureBundle, GenerateRequest, GeneratedServerArtifact, LegalMode, RegistryEntry, ToolDefinition } from "@mcp/types";
import { aggregateConfidence } from "@mcp/types";
import { inferTools, validateCandidates, type InferenceClient } from "./inference.js";
import { coverageOf, toolSig } from "./incremental.js";
import { generateServer } from "./codegen.js";
import { chooseBrowserBackend, deriveDynamicSignals } from "./opencli-backend.js";

/**
 * `generate` use-case: scraper -> inference -> codegen -> persist. Scraper + persistence are ports, so this
 * orchestrator builds and tests with zero live services.
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
  /** Optional sub-page discovery (sitemap/robots/API spec); merged into the inferred set, deduped. Best-effort. */
  discoverSubPages?: (pageUrl: string) => Promise<ToolDefinition[]>;
  /** Optional live verification; returns confidence-annotated tools. Best-effort. */
  verifyTools?: (tools: ToolDefinition[], pageUrl: string) => Promise<ToolDefinition[]>;
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

  const enriched = await withSubPageTools(result.tools, req.url, deps.discoverSubPages);
  const tools = await withLiveVerification(enriched, req.url, deps.verifyTools);
  const confidence = tools === result.tools ? result.confidence : aggregateConfidence(tools.map((t) => t.confidence));

  const { serverId, version } = await deps.persistence.nextServer(req.url);
  const title = bundle.meta.title ?? req.url;
  // Ship the browsing toolkit when the page is interactive (JS-rendered, has actions/forms, or a browser tool).
  const browsing =
    bundle.meta.renderedWithJs ||
    (bundle.page?.actions?.length ?? 0) > 0 ||
    (bundle.page?.forms?.length ?? 0) > 0 ||
    tools.some((t) => t.execution.kind === "browser");
  const dynamicBackend = chooseBrowserBackend(deriveDynamicSignals(bundle));
  const artifact = generateServer({ serverId, version, url: req.url, title, tools, browsing, dynamicBackend });

  // Zero usable tools => broken, UNLESS it ships the browsing toolkit (driveable turn-by-turn, e.g. Skyscanner).
  const status: RegistryEntry["status"] = tools.length === 0 && !browsing ? "broken" : "active";

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

/** Merge sub-page-discovered tools into the inferred set, deduped by name + endpoint sig. Best-effort. */
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

/** Run optional live verification; returns confidence-annotated tools, or the inputs on absence/failure. */
async function withLiveVerification(
  tools: ToolDefinition[],
  pageUrl: string,
  verify?: (tools: ToolDefinition[], pageUrl: string) => Promise<ToolDefinition[]>,
): Promise<ToolDefinition[]> {
  if (!verify) return tools;
  try {
    return await verify(tools, pageUrl);
  } catch {
    return tools; // verification is best-effort; a failure must never block generation
  }
}
