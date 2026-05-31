import { ToolDefinition, aggregateConfidence, type CaptureBundle, type SelfHealJob, type ToolFailure } from "@mcp/types";
import { generateServer } from "./codegen.js";
import type { Scraper } from "./generate.js";
import type { VersionPersistence } from "./version-write.js";

/**
 * Self-healer (`services/generator.md`, the differentiator). Given a SelfHealJob, re-snapshot the source
 * and ask Claude to rewrite ONLY the failing tool, then bump the version.
 * Acceptance (enforced by tests): a heal changes EXACTLY the failing tool and increments the version —
 * nothing else moves. The Claude call is behind `HealClient` so this is testable with zero network.
 *
 * v1: re-snapshots the whole source URL (a lighter per-tool path is an open question in `03`).
 */
export interface HealClient {
  /** Returns raw JSON for the single rewritten tool (same name as the failing tool). */
  proposeHeal(failingTool: ToolDefinition, bundle: CaptureBundle, failure: ToolFailure): Promise<string>;
}

export interface CurrentServer {
  url: string;
  title: string;
  version: number;
  tools: ToolDefinition[];
}

export interface SelfHealDeps {
  scraper: Scraper;
  heal: HealClient;
  persistence: VersionPersistence;
}

export interface SelfHealOutcome {
  healed: boolean;
  serverId: string;
  /** New version if healed; the unchanged current version otherwise. */
  version: number;
  toolName: string;
  status: "active" | "degraded";
}

/** Pull the single candidate tool out of whatever envelope the heal client returned. */
function extractHealed(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed[0];
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { tool?: unknown; name?: unknown };
      if (obj.tool) return obj.tool;
      return parsed; // a bare tool object
    }
  } catch {
    /* heal produced non-JSON */
  }
  return undefined;
}

export async function selfHeal(job: SelfHealJob, current: CurrentServer, deps: SelfHealDeps): Promise<SelfHealOutcome> {
  const failed = (status: "degraded"): SelfHealOutcome => ({
    healed: false,
    serverId: job.serverId,
    version: current.version,
    toolName: job.toolName,
    status,
  });

  const failing = current.tools.find((t) => t.name === job.toolName);
  if (!failing) return failed("degraded"); // unknown tool — nothing to heal

  const bundle = await deps.scraper.capture(current.url, "safe");
  const raw = await deps.heal.proposeHeal(failing, bundle, job.failure);

  const parsed = ToolDefinition.safeParse(extractHealed(raw));
  // A heal must produce a VALID tool that keeps the SAME name (can't rename or invent a new tool).
  if (!parsed.success || parsed.data.name !== job.toolName) return failed("degraded");
  const healedTool = parsed.data;

  // Replace exactly the failing tool; every other tool is carried over byte-for-byte.
  const newTools = current.tools.map((t) => (t.name === job.toolName ? healedTool : t));
  const newVersion = current.version + 1;

  const artifact = generateServer({
    serverId: job.serverId,
    version: newVersion,
    url: current.url,
    title: current.title,
    tools: newTools,
  });
  const artifactUrl = await deps.persistence.saveArtifact(artifact);
  // writeVersion both inserts the new version AND repoints servers.current_version → newVersion with
  // status active — without that the heal would write v+1 while the server still serves the broken v.
  await deps.persistence.writeVersion({
    serverId: job.serverId,
    version: newVersion,
    tools: newTools,
    confidence: aggregateConfidence(newTools.map((t) => t.confidence)),
    artifactUrl,
    createdBy: "self_heal",
    status: "active",
    lastParsedAt: new Date().toISOString(),
  });

  return { healed: true, serverId: job.serverId, version: newVersion, toolName: job.toolName, status: "active" };
}
