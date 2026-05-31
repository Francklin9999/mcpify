import { z } from "zod";
import { JsonSchema } from "./common.js";
import { LegalMode } from "./legal.js";
import { CaptureBundle } from "./capture.js";
import { GeneratedServerArtifact } from "./artifact.js";
import { ToolDefinition } from "./tools.js";

/**
 * POST /api/generate (`01 §7`). `full_scrape` is UNREACHABLE without explicit acknowledgement (`04`).
 * The web app gates this behind a confirm dialog; the schema enforces the invariant server-side too.
 */
export const GenerateRequest = z
  .object({
    url: z.string().url(),
    legalMode: LegalMode,
    acknowledgedFullScrape: z.boolean().optional(),
    /** Optional high-signal extension capture. If present, generation should use this instead of re-fetching. */
    bundle: CaptureBundle.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.legalMode === "full_scrape" && b.acknowledgedFullScrape !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "full_scrape requires explicit acknowledgement (see docs/04-legal-modes.md)",
        path: ["acknowledgedFullScrape"],
      });
    }
    if (b.bundle && b.bundle.url !== b.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bundle.url must match request url",
        path: ["bundle", "url"],
      });
    }
  });
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const GenerateResponse = z.object({ jobId: z.string() });
export type GenerateResponse = z.infer<typeof GenerateResponse>;

/** GET /api/jobs/:jobId */
export const JobStatusResponse = z.object({
  status: z.enum(["queued", "running", "done", "failed"]),
  result: GeneratedServerArtifact.optional(),
  error: z.string().optional(),
});
export type JobStatusResponse = z.infer<typeof JobStatusResponse>;

/** POST /api/servers/:id/contribute — extension passive contribution / community (`03` Flow C). */
export const ContributeRequest = z.object({ bundle: CaptureBundle });
export type ContributeRequest = z.infer<typeof ContributeRequest>;

export const AssistMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type AssistMessage = z.infer<typeof AssistMessage>;

/**
 * A browsing tool the side-panel agent can ask the model to call (OpenAI function-calling shape). These are
 * the LIVE-TAB primitives (browser_navigate/click/type/snapshot/...), NOT a generated-server ExecutionStrategy
 * — the side panel executes them against the user's current tab. `availableTools` (above) stays the read-only
 * list of a generated server's tools; `tools` (below) is the actionable set for the agent loop.
 */
export const AssistToolSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  parameters: JsonSchema,
});
export type AssistToolSpec = z.infer<typeof AssistToolSpec>;

/** One tool the model wants the side panel to run, with arguments parsed from the model's call. */
export const AssistToolCall = z.object({
  id: z.string().optional(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type AssistToolCall = z.infer<typeof AssistToolCall>;

/**
 * One step of the agent loop: the model's next move. `toolCalls` empty/absent => the turn is done and `text`
 * is the final answer. Returned by POST /api/assist when the request carries `tools` (JSON, not streamed).
 */
export const AssistStepResponse = z.object({
  text: z.string().optional(),
  toolCalls: z.array(AssistToolCall).optional(),
});
export type AssistStepResponse = z.infer<typeof AssistStepResponse>;

export const AssistRequest = z.object({
  messages: z.array(AssistMessage).min(1),
  pageContext: z
    .object({
      url: z.string().url().optional(),
      title: z.string().optional(),
      visibleText: z.string().max(12000).optional(),
    })
    .optional(),
  availableTools: z.array(ToolDefinition).optional(),
  /**
   * Actionable live-tab tools for the side-panel agent loop. When present, /api/assist runs ONE function-
   * calling step and returns an AssistStepResponse (JSON) instead of a streamed text turn. Additive: absent
   * => the legacy streamed-chat behavior is unchanged.
   */
  tools: z.array(AssistToolSpec).optional(),
});
export type AssistRequest = z.infer<typeof AssistRequest>;

/**
 * POST /api/discover — SYNCHRONOUS incremental discovery for the side panel. Given the tools already known
 * for the page and a fresh capture, return the genuinely-new tools (for live in-session use) + the merged
 * set. If `serverId` is present, the registry server is ALSO grown (a discover job is enqueued). The model is
 * sent only the delta (token-efficient); when nothing is new, `added` is empty and no model call happens.
 */
export const DiscoverRequest = z.object({
  currentTools: z.array(ToolDefinition),
  bundle: CaptureBundle,
  serverId: z.string().uuid().optional(),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;

export const DiscoverResponse = z.object({
  added: z.array(ToolDefinition),
  tools: z.array(ToolDefinition),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponse>;
