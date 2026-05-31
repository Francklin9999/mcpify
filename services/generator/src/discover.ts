import { aggregateConfidence, type DiscoverJob } from "@mcp/types";
import { generateServer } from "./codegen.js";
import { discoverMore, mergeCandidates } from "./incremental.js";
import type { InferenceClient } from "./inference.js";
import type { CurrentServer } from "./self-heal.js";
import type { VersionPersistence } from "./version-write.js";

/**
 * `discover` handler — the CONTINUOUS-generation path. Unlike `regenerate` (which re-infers ALL tools
 * wholesale from a fresh scrape), this takes a NEW capture of an existing server's page and runs INCREMENTAL
 * discovery: it merges only genuinely-new tools (`incremental.ts`) and bumps the version. Two efficiencies
 * are the whole point:
 *   - the model is sent only the delta (never re-sees material it already tooled), and
 *   - if nothing new was found, NO new version is written (no churn, no wasted artifact).
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

  // No new capability surfaced — do NOT write a version (avoid churning the registry on every capture).
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
