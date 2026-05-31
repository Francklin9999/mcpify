import { z } from "zod";
import { ToolDefinition } from "./tools.js";

export const GeneratedFile = z.object({
  path: z.string(),
  content: z.string(),
});
export type GeneratedFile = z.infer<typeof GeneratedFile>;

/** Output of codegen (`01 S3`): a runnable MCP server + the config snippet the user pastes. */
export const GeneratedServerArtifact = z.object({
  serverId: z.string().uuid(),
  version: z.number().int().positive(),
  files: z.array(GeneratedFile),
  entrypoint: z.string(),
  configSnippet: z.string(),
  artifactUrl: z.string().url().optional(),
  /**
   * The structured tool definitions baked into this server. Carried so a client (e.g. the extension side
   * panel) can "Apply" the server and use its tools DIRECTLY without re-parsing server.ts or a DB round-trip.
   * Optional for back-compat with artifacts generated before this field existed.
   */
  tools: z.array(ToolDefinition).optional(),
});
export type GeneratedServerArtifact = z.infer<typeof GeneratedServerArtifact>;
