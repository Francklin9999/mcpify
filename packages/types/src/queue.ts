import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { LegalMode } from "./legal.js";
import { CaptureBundle } from "./capture.js";
import { ToolDefinition } from "./tools.js";

/** BullMQ queue name (no `:` - BullMQ reserves it for Redis key namespacing). */
export const QUEUE_NAME = "mcp-jobs";

export const ToolFailure = z.object({
  toolName: z.string(),
  errorClass: z.enum(["selector_miss", "http_4xx", "http_5xx", "schema_mismatch", "timeout"]),
  detail: z.string(),
  observedAt: IsoDateTime,
});
export type ToolFailure = z.infer<typeof ToolFailure>;

/** `generate` originates from web/extension API. */
export const GenerateJob = z.object({
  kind: z.literal("generate"),
  url: z.string().url(),
  legalMode: LegalMode,
  requestedBy: z.string(),
  /** Optional extension capture; lets generation use the user's live browser observation instead of a server re-fetch. */
  bundle: CaptureBundle.optional(),
});
export type GenerateJob = z.infer<typeof GenerateJob>;

/** `regenerate` is produced ONLY by the Go monitor on large drift (or manual). */
export const RegenerateJob = z.object({
  kind: z.literal("regenerate"),
  serverId: z.string().uuid(),
  reason: z.enum(["large_drift", "manual"]),
});
export type RegenerateJob = z.infer<typeof RegenerateJob>;

/** `self_heal` is produced ONLY by the Go monitor on a tool failure; handled by generator (Node+Claude). */
export const SelfHealJob = z.object({
  kind: z.literal("self_heal"),
  serverId: z.string().uuid(),
  toolName: z.string(),
  failure: ToolFailure,
});
export type SelfHealJob = z.infer<typeof SelfHealJob>;

/**
 * `discover` is produced by web/extension: a new capture of an existing server's page. The worker runs
 * incremental discovery, merging only genuinely-new tools and bumping the version (or no-ops when nothing is new).
 */
export const DiscoverJob = z.object({
  kind: z.literal("discover"),
  serverId: z.string().uuid(),
  bundle: CaptureBundle,
  /** Pre-computed tools from a synchronous /api/discover pass; when present the worker merges them model-free. */
  candidates: z.array(ToolDefinition).optional(),
});
export type DiscoverJob = z.infer<typeof DiscoverJob>;

/**
 * `deepen` is produced by the generator after a successful generate (and by the monitor on small drift): it
 * captures a few sub-pages and runs incremental discovery, writing one merged version. Never enqueues another job.
 */
export const DeepenJob = z.object({
  kind: z.literal("deepen"),
  serverId: z.string().uuid(),
  url: z.string().url(),
  legalMode: LegalMode,
});
export type DeepenJob = z.infer<typeof DeepenJob>;

/** The full job space, discriminated on `kind` - the entire Go->Node decoupling contract (`01 S4`). */
export const Job = z.discriminatedUnion("kind", [GenerateJob, RegenerateJob, SelfHealJob, DiscoverJob, DeepenJob]);
export type Job = z.infer<typeof Job>;
export type JobKind = Job["kind"];
