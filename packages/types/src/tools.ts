import { z } from "zod";
import { JsonSchema, Confidence, LIMITS } from "./common.js";
import { NetworkCapture, ElementRef } from "./capture.js";

/** ExecutionStrategy discriminants. Exported so the DB execution_kind enum can parity-check against it. */
export const EXECUTION_KINDS = ["http", "browser"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** How a ToolDefinition's input fields fill a discovered request. */
export const ParamMapping = z.record(
  z.string().max(128),
  z.object({
    in: z.enum(["path", "query", "header", "body"]),
    key: z.string().max(256),
  }),
);
export type ParamMapping = z.infer<typeof ParamMapping>;

/** A single browser-driven action. `value` may interpolate a param via `{{paramName}}`. */
export const BrowserStep = z.object({
  action: z.enum(["navigate", "fill", "click", "selectOption", "pressKey", "waitFor", "extract"]),
  target: ElementRef.optional(),
  value: z.string().max(4_000).optional(),
});
export type BrowserStep = z.infer<typeof BrowserStep>;

/**
 * ExecutionStrategy - frozen v1: http | browser only, discriminated on `kind`. No runtime-auth field
 * (session-mode execution is post-v1).
 */
export const ExecutionStrategy = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    request: NetworkCapture,
    paramMapping: ParamMapping,
  }),
  z.object({
    kind: z.literal("browser"),
    steps: z.array(BrowserStep).max(50),
  }),
]);
export type ExecutionStrategy = z.infer<typeof ExecutionStrategy>;

/** One inferred MCP tool. `name` is snake_case; `inputSchema` is zod-validated before codegen (`generator.md`). */
export const ToolDefinition = z.object({
  name: z.string().max(64).regex(/^[a-z][a-z0-9_]*$/, "name must be snake_case"),
  description: z.string().min(1).max(1_000),
  inputSchema: JsonSchema,
  execution: ExecutionStrategy,
  confidence: Confidence,
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

/** Output of inference, input to codegen (`01 S2`). */
export const InferenceResult = z.object({
  url: z.string().url(),
  bundleId: z.string().uuid(),
  tools: z.array(ToolDefinition).max(LIMITS.maxTools),
  confidence: Confidence,
  modelVersion: z.string(),
});
export type InferenceResult = z.infer<typeof InferenceResult>;
