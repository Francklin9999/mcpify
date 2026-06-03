import { z } from "zod";
import { LIMITS } from "./common.js";
import { ToolDefinition } from "./tools.js";

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return false;
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export const GeneratedFile = z.object({
  path: z.string().max(240).refine(isSafeRelativePath, "path must be a safe relative path"),
  content: z.string().max(LIMITS.maxGeneratedFileBytes),
});
export type GeneratedFile = z.infer<typeof GeneratedFile>;

/** Output of codegen (`01 S3`): a runnable MCP server + the config snippet the user pastes. */
export const GeneratedServerArtifact = z.object({
  serverId: z.string().uuid(),
  version: z.number().int().positive(),
  files: z.array(GeneratedFile).max(LIMITS.maxGeneratedFiles),
  entrypoint: z.string().max(240).refine(isSafeRelativePath, "entrypoint must be a safe relative path"),
  configSnippet: z.string().max(200_000),
  artifactUrl: z.string().url().optional(),
  /**
   * The structured tool definitions baked into this server. Carried so a client (e.g. the extension side
   * panel) can "Apply" the server and use its tools DIRECTLY without re-parsing server.ts or a DB round-trip.
   * Optional for back-compat with artifacts generated before this field existed.
   */
  tools: z.array(ToolDefinition).max(LIMITS.maxTools).optional(),
});
export type GeneratedServerArtifact = z.infer<typeof GeneratedServerArtifact>;
