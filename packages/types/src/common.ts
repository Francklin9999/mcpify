import { z } from "zod";

/**
 * JSON Schema representation (v1): a permissive object keyed by string.
 * `01-contracts.md` open question - trimmed subset vs. full JSON Schema draft. Kept as ONE named alias
 * so every producer/consumer agrees and can be tightened later without touching call sites.
 */
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const LIMITS = {
  maxString: 8_000,
  maxLongText: 120_000,
  maxHtml: 200_000,
  maxHeaders: 64,
  maxHeaderValue: 2_000,
  maxNetworkCalls: 200,
  maxTools: 128,
  maxGeneratedFiles: 64,
  maxGeneratedFileBytes: 1_000_000,
} as const;

/** ISO-8601 timestamp (offsets allowed). Used on every `*At` field. */
export const IsoDateTime = z.string().datetime({ offset: true });

/**
 * Confidence is a contract invariant: always in [0,1] (`01 S5`). The schema rejects out-of-range;
 * `clampConfidence` is the shared helper any producer uses before it ever constructs a value.
 * NOTE: confidence *band* thresholds (verified/strong/fair) are a UI concern and live in apps/web-ui - NOT here.
 */
export const Confidence = z.number().min(0).max(1);
export const clampConfidence = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Aggregate a server's confidence from its per-tool confidences (`01 S5`, single source of truth).
 * v1: equal-weighted mean, clamped to [0,1]. An empty tool set is 0 (a server with no tools is not usable).
 * Centralized here so generator + monitor + web never roll divergent formulas. Refine the weighting in
 * ONE place if needed later.
 */
export function aggregateConfidence(toolConfidences: readonly number[]): number {
  if (toolConfidences.length === 0) return 0;
  const sum = toolConfidences.reduce((a, c) => a + clampConfidence(c), 0);
  return clampConfidence(sum / toolConfidences.length);
}
