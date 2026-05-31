import type { ServerStatus } from "@mcp/types";

/**
 * Confidence visual system (docs/apps/web-ui.md). The band derives SOLELY from confidence + status -
 * no per-card hardcoding. `broken` forces the low treatment regardless of score; `regenerating` is a
 * transient self-healing state.
 */
export type Band = {
  label: string;
  tone: "verified" | "strong" | "fair" | "low" | "healing";
  /** CSS var name for the ramp (defined in globals.css). */
  colorVar: string;
};

export function confidenceBand(confidence: number, status: ServerStatus): Band {
  if (status === "regenerating") return { label: "SELF-HEALING", tone: "healing", colorVar: "--c-healing" };
  if (status === "broken") return { label: "NEEDS HEALING", tone: "low", colorVar: "--c-low" };
  if (confidence >= 0.95) return { label: "VERIFIED", tone: "verified", colorVar: "--c-verified" };
  if (confidence >= 0.8) return { label: "STRONG", tone: "strong", colorVar: "--c-strong" };
  if (confidence >= 0.6) return { label: "FAIR", tone: "fair", colorVar: "--c-fair" };
  return { label: "NEEDS HEALING", tone: "low", colorVar: "--c-low" };
}

export const pct = (confidence: number): number => Math.round(confidence * 100);
