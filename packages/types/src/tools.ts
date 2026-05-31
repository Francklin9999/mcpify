import { z } from "zod";
import { JsonSchema, Confidence } from "./common.js";
import { NetworkCapture, ElementRef } from "./capture.js";

/** Execution kinds — the `ExecutionStrategy` discriminants. Exported so the DB `execution_kind` enum can
 *  parity-check against the contract (`packages/db`). Keep in sync with the union below. */
export const EXECUTION_KINDS = ["http", "browser"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** How a ToolDefinition's input fields fill a discovered request. */
export const ParamMapping = z.record(
  z.string(),
  z.object({
    in: z.enum(["path", "query", "header", "body"]),
    key: z.string(),
  }),
);
export type ParamMapping = z.infer<typeof ParamMapping>;

/** A single browser-driven action. `value` may interpolate a param via `{{paramName}}`. */
export const BrowserStep = z.object({
  action: z.enum(["navigate", "fill", "click", "selectOption", "pressKey", "waitFor", "extract"]),
  target: ElementRef.optional(),
  value: z.string().optional(),
});
export type BrowserStep = z.infer<typeof BrowserStep>;

/**
 * ExecutionStrategy — FROZEN v1: `http | browser` ONLY. Discriminated on `kind` so codegen can switch
 * cleanly and bad payloads fail with a clear tag error.
 * There is intentionally NO runtime-auth field: session-mode EXECUTION is post-v1 (`01 §2` decision).
 */
export const ExecutionStrategy = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    request: NetworkCapture,
    paramMapping: ParamMapping,
  }),
  z.object({
    kind: z.literal("browser"),
    steps: z.array(BrowserStep),
  }),
]);
export type ExecutionStrategy = z.infer<typeof ExecutionStrategy>;

/** One inferred MCP tool. `name` is snake_case; `inputSchema` is zod-validated before codegen (`generator.md`). */
export const ToolDefinition = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "name must be snake_case"),
  description: z.string().min(1),
  inputSchema: JsonSchema,
  execution: ExecutionStrategy,
  confidence: Confidence,
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

/** Output of inference, input to codegen (`01 §2`). */
export const InferenceResult = z.object({
  url: z.string().url(),
  bundleId: z.string().uuid(),
  tools: z.array(ToolDefinition),
  confidence: Confidence,
  modelVersion: z.string(),
});
export type InferenceResult = z.infer<typeof InferenceResult>;
