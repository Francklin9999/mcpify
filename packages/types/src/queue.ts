import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { LegalMode } from "./legal.js";
import { CaptureBundle } from "./capture.js";
import { ToolDefinition } from "./tools.js";

/** Redis/BullMQ queue name. Go (monitor) produces; Node (generator) consumes (`01 §4`).
 *  No `:` — BullMQ reserves it for Redis key namespacing (`bull:mcp-jobs:*`) and rejects it in the name. */
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
 * `discover` is produced by the WEB/EXTENSION (like `generate`, never the monitor): a new capture of an
 * EXISTING server's page after a reactive page revealed new structure. The worker runs INCREMENTAL discovery
 * — merges only genuinely-new tools and bumps the version, or no-ops when nothing is new (`incremental.ts`).
 * Additive extension of the frozen `01 §4` union; the Go monitor still only produces `regenerate`/`self_heal`.
 */
export const DiscoverJob = z.object({
  kind: z.literal("discover"),
  serverId: z.string().uuid(),
  bundle: CaptureBundle,
  /**
   * Pre-computed new tools from a SYNCHRONOUS /api/discover pass. When present the worker MERGES them
   * model-free (no second inference for the same material — the route already paid for it) and writes the
   * version. Absent (e.g. a plain /contribute) ⇒ the worker runs incremental discovery itself.
   */
  candidates: z.array(ToolDefinition).optional(),
});
export type DiscoverJob = z.infer<typeof DiscoverJob>;

/** The full job space, discriminated on `kind` — the entire Go→Node decoupling contract (`01 §4`). */
export const Job = z.discriminatedUnion("kind", [GenerateJob, RegenerateJob, SelfHealJob, DiscoverJob]);
export type Job = z.infer<typeof Job>;
export type JobKind = Job["kind"];
