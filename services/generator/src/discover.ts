import { aggregateConfidence, type DiscoverJob } from "@mcp/types";
import { generateServer } from "./codegen.js";
import { chooseBrowserBackend, deriveDynamicSignals } from "./opencli-backend.js";
import { discoverMore, mergeCandidates } from "./incremental.js";
import type { InferenceClient } from "./inference.js";
import type { CurrentServer } from "./self-heal.js";
import type { VersionPersistence } from "./version-write.js";

/**
 * `discover` handler (continuous generation): take a new capture of an existing server's page, run
 * incremental discovery, merge only genuinely-new tools, and bump the version. The model sees only the
 * delta; nothing new => no new version (no churn).
 */
export interface DiscoverDeps {
  inference: InferenceClient;
  persistence: VersionPersistence;
}

export interface DiscoverOutcome {
  serverId: string;
  /** how many genuinely-new tools were added (0 => no version written). */
  discovered: number;
  /** new version if tools were added; the unchanged current version otherwise. */
  version: number;
  wroteVersion: boolean;
  toolCount: number;
  calledModel: boolean;
}

export async function discover(job: DiscoverJob, current: CurrentServer, deps: DiscoverDeps): Promise<DiscoverOutcome> {
  // If a synchronous /api/discover pass already found the new tools, MERGE them model-free (no second
  // inference for the same material). Otherwise (e.g. a plain /contribute) run incremental discovery here.
  const { added, tools, calledModel } = job.candidates?.length
    ? { ...mergeCandidates(current.tools, job.candidates), calledModel: false }
    : await discoverMore(current.tools, job.bundle, deps.inference);

  // No new capability surfaced - do NOT write a version (avoid churning the registry on every capture).
  if (added.length === 0) {
    return {
      serverId: job.serverId,
      discovered: 0,
      version: current.version,
      wroteVersion: false,
      toolCount: current.tools.length,
      calledModel,
    };
  }

  const newVersion = current.version + 1;
  const artifact = generateServer({
    serverId: job.serverId,
    version: newVersion,
    url: current.url,
    title: current.title,
    tools,
    browsing: job.bundle.meta.renderedWithJs || tools.some((t) => t.execution.kind === "browser"),
    dynamicBackend: chooseBrowserBackend(deriveDynamicSignals(job.bundle)),
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
    calledModel,
  };
}
