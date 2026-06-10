import { z } from "zod";
import { JsonSchema, LIMITS } from "./common.js";
import { LegalMode } from "./legal.js";
import { CaptureBundle } from "./capture.js";
import { GeneratedServerArtifact } from "./artifact.js";
import { ToolDefinition } from "./tools.js";

/** POST /api/generate. full_scrape is unreachable without explicit acknowledgement (enforced server-side here). */
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

/** POST /api/servers/:id/contribute - extension passive contribution / community (`03` Flow C). */
export const ContributeRequest = z.object({ bundle: CaptureBundle });
export type ContributeRequest = z.infer<typeof ContributeRequest>;

export const AssistMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(16_000),
});
export type AssistMessage = z.infer<typeof AssistMessage>;

/** A live-tab browsing tool the side-panel agent can call (OpenAI function-calling shape). */
export const AssistToolSpec = z.object({
  name: z.string().max(64).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(1_000),
  parameters: JsonSchema,
});
export type AssistToolSpec = z.infer<typeof AssistToolSpec>;

/** One tool the model wants the side panel to run, with arguments parsed from the model's call. */
export const AssistToolCall = z.object({
  id: z.string().max(256).optional(),
  name: z.string().max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type AssistToolCall = z.infer<typeof AssistToolCall>;

/** One step of the agent loop. Empty toolCalls => the turn is done and `text` is the final answer. */
export const AssistStepResponse = z.object({
  text: z.string().optional(),
  toolCalls: z.array(AssistToolCall).optional(),
});
export type AssistStepResponse = z.infer<typeof AssistStepResponse>;

export const AssistRequest = z.object({
  messages: z.array(AssistMessage).min(1).max(40),
  pageContext: z
    .object({
      url: z.string().url().optional(),
      title: z.string().max(512).optional(),
      visibleText: z.string().max(12000).optional(),
    })
    .optional(),
  availableTools: z.array(ToolDefinition).max(LIMITS.maxTools).optional(),
  /** Live-tab tools for the agent loop. When present, /api/assist runs one function-calling step (JSON, not streamed). */
  tools: z.array(AssistToolSpec).max(64).optional(),
});
export type AssistRequest = z.infer<typeof AssistRequest>;

/** POST /api/discover - synchronous incremental discovery: returns genuinely-new tools + the merged set. */
export const DiscoverRequest = z.object({
  currentTools: z.array(ToolDefinition).max(LIMITS.maxTools),
  bundle: CaptureBundle,
  serverId: z.string().uuid().optional(),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;

export const DiscoverResponse = z.object({
  added: z.array(ToolDefinition).max(LIMITS.maxTools),
  tools: z.array(ToolDefinition).max(LIMITS.maxTools),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponse>;
