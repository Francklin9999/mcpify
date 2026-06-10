import type { ServerStatus } from "@mcp/types";

/** Confidence band derived from confidence + status. `broken` forces the low band; `regenerating` is transient. */
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
