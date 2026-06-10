import { z } from "zod";

/** JSON Schema (permissive object keyed by string). One named alias so it can be tightened later. */
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

/** Confidence: always in [0,1]. */
export const Confidence = z.number().min(0).max(1);
export const clampConfidence = (n: number): number => Math.min(1, Math.max(0, n));

/** Aggregate a server's confidence from its per-tool confidences: equal-weighted mean, 0 for an empty set. */
export function aggregateConfidence(toolConfidences: readonly number[]): number {
  if (toolConfidences.length === 0) return 0;
  const sum = toolConfidences.reduce((a, c) => a + clampConfidence(c), 0);
  return clampConfidence(sum / toolConfidences.length);
}
