import type { ToolDefinition } from "@mcp/types";
import type { generateServer } from "./codegen.js";

/**
 * Shared contract for persisting a NEW version of an EXISTING server (self-heal and regenerate both do
 * this). Distinct from `generate()`'s first-time `writeRegistry`, which creates the server row.
 */
export interface VersionWrite {
  serverId: string;
  version: number;
  tools: ToolDefinition[];
  confidence: number;
  artifactUrl: string;
  createdBy: "self_heal" | "auto";
  /** Status the server should now be in (`active` when tools were produced, `broken` when none were). */
  status: "active" | "broken";
  lastParsedAt: string;
}

export interface VersionPersistence {
  saveArtifact(artifact: ReturnType<typeof generateServer>): Promise<string>;
  /**
   * MUST do BOTH, or the new version never goes live:
   *  1. insert the `server_versions` row + `tools`, and
   *  2. update the `servers` row pointer: `current_version = version`, `status`, `confidence`,
   *     `last_parsed_at`.
   * (This is the "the row that makes it live" step - see the `current_version` decision in `02`.)
   */
  writeVersion(write: VersionWrite): Promise<void>;
}
