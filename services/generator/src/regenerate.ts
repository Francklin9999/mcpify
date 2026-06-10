import { aggregateConfidence, type RegenerateJob } from "@mcp/types";
import { inferTools, type InferenceClient } from "./inference.js";
import { generateServer } from "./codegen.js";
import { chooseBrowserBackend, deriveDynamicSignals } from "./opencli-backend.js";
import type { Scraper } from "./generate.js";
import type { CurrentServer } from "./self-heal.js";
import type { VersionPersistence } from "./version-write.js";

/**
 * `regenerate` handler (large-drift): re-parse an existing server and bump its version (vs generate(), which
 * allocates a new serverId). Re-infers all tools wholesale; 0 tools => the new version is broken.
 */
export interface RegenerateDeps {
  scraper: Scraper;
  inference: InferenceClient;
  persistence: VersionPersistence;
}

export interface RegenerateOutcome {
  serverId: string;
  version: number;
  status: "active" | "broken";
  toolCount: number;
  droppedCount: number;
  confidence: number;
}

export async function regenerate(job: RegenerateJob, current: CurrentServer, deps: RegenerateDeps): Promise<RegenerateOutcome> {
  const bundle = await deps.scraper.capture(current.url, "safe");
  const { result, droppedCount } = await inferTools(bundle, deps.inference);

  const newVersion = current.version + 1;
  const browsing =
    bundle.meta.renderedWithJs ||
    (bundle.page?.actions?.length ?? 0) > 0 ||
    (bundle.page?.forms?.length ?? 0) > 0 ||
    result.tools.some((t) => t.execution.kind === "browser");
  // Parity with generate(): a server that ships the browser_* toolkit is driveable even with zero INFERRED
  // tools (the dynamic/opencli case), so it is active - only a truly empty, non-browsing server is broken.
  const status: "active" | "broken" = result.tools.length === 0 && !browsing ? "broken" : "active";
  const dynamicBackend = chooseBrowserBackend(deriveDynamicSignals(bundle));
  const artifact = generateServer({
    serverId: job.serverId,
    version: newVersion,
    url: current.url,
    title: current.title,
    tools: result.tools,
    browsing,
    dynamicBackend,
  });
  const artifactUrl = await deps.persistence.saveArtifact(artifact);
  await deps.persistence.writeVersion({
    serverId: job.serverId,
    version: newVersion,
    tools: result.tools,
    confidence: result.confidence,
    artifactUrl,
    createdBy: "auto",
    status,
    lastParsedAt: new Date().toISOString(),
  });

  return {
    serverId: job.serverId,
    version: newVersion,
    status,
    toolCount: result.tools.length,
    droppedCount,
    confidence: aggregateConfidence(result.tools.map((t) => t.confidence)),
  };
}
