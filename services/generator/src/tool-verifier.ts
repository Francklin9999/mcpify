import type { ToolDefinition } from "@mcp/types";
import { readResponseTextWithLimit } from "./http-limits.js";
import { assertPublicHttpUrl } from "./url-safety.js";

/**
 * Live tool verification: probe each tool against the real site to prove it works, not just that it's
 * structurally valid. Only idempotent GET/HEAD are replayed (writes are reported not_verifiable, never
 * fired); a 200 carrying an anti-bot challenge is `blocked`, not `verified`; placeholder targets are
 * not_verifiable. verifyAndAnnotate nudges confidence without pruning; verifyAndFilter is the opt-in prune.
 * Pure core + an injected probe, so it tests offline.
 */

export type VerifyStatus = "verified" | "dead" | "blocked" | "not_verifiable";

export interface ToolVerification {
  name: string;
  status: VerifyStatus;
  /** Reason for not_verifiable, or the error for dead. */
  reason?: string;
  httpStatus?: number;
  target?: string;
  /** True when a FRESH (un-captured) param value also returned real content - the template generalizes. */
  generalized?: boolean;
}

export interface VerifyReport {
  verifications: ToolVerification[];
  verified: number;
  dead: number;
  blocked: number;
  notVerifiable: number;
  /** Tools whose `{param}` template was proven on a fresh, never-captured value. */
  generalized: number;
}

/** Injected network probe (GET/HEAD only). Returns status + a body slice, or null on network failure. */
export type ProbeFn = (url: string, method: "GET" | "HEAD") => Promise<{ status: number; body: string } | null>;

// Anti-bot challenge markers - a 200 carrying any of these is a wall, not real content (mirrors the
// scraper's conservative set so verification agrees with capture).
const BOT_MARKERS = [
  "captcha",
  "enter the characters you see",
  "automated access",
  "unusual traffic",
  "/cdn-cgi/challenge",
  "just a moment...",
  "verify you are a human",
  "are you a robot",
  "access to this page has been denied",
  "px-captcha",
];

// A rawUrl we can't meaningfully fetch: an unresolved placeholder or a known recipe stand-in value.
const PLACEHOLDER_RE = /\{|\}|B000000000|example\.com|\bplaceholder\b/i;

function looksBlocked(body: string): boolean {
  const hay = body.slice(0, 20000).toLowerCase();
  return BOT_MARKERS.some((m) => hay.includes(m));
}

function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function pathParam(tool: ToolDefinition): string | null {
  if (tool.execution.kind !== "http") return null;
  for (const [name, m] of Object.entries(tool.execution.paramMapping)) {
    if (m.in === "path") return name;
  }
  return null;
}

export interface VerificationTargets {
  /** The captured target (the tool's own rawUrl), proving the endpoint is still live. */
  captured?: { method: "GET" | "HEAD"; url: string };
  /** A fresh target built from the urlPattern with an un-captured value, proving the template generalizes. */
  fresh?: { method: "GET"; url: string; param: string; value: string };
  /** Set when the tool cannot be safely/meaningfully verified. */
  skip?: string;
}

/**
 * Decide what (if anything) to fetch for a tool. GET/HEAD only; browser tools, non-idempotent methods, and
 * placeholder targets are skipped with a reason. When `freshValues` supplies a value for the tool's path
 * param, also build a fresh-value URL from `origin(rawUrl) + urlPattern` to test template generalization.
 */
export function verificationTargets(tool: ToolDefinition, freshValues: Record<string, string> = {}): VerificationTargets {
  if (tool.execution.kind !== "http") return { skip: "browser tool (no HTTP target)" };
  const req = tool.execution.request;
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return { skip: `non-idempotent method ${method} (never replayed live)` };
  if (PLACEHOLDER_RE.test(req.rawUrl)) return { skip: "placeholder target (no captured value to verify)" };

  const targets: VerificationTargets = { captured: { method: method as "GET" | "HEAD", url: req.rawUrl } };

  const param = pathParam(tool);
  const origin = originOf(req.rawUrl);
  if (param && origin && freshValues[param] && req.urlPattern.includes(`{${param}}`)) {
    const path = req.urlPattern.replace(`{${param}}`, encodeURIComponent(freshValues[param]!));
    targets.fresh = { method: "GET", url: `${origin}${path}`, param, value: freshValues[param]! };
  }
  return targets;
}

function classify(probe: { status: number; body: string } | null): { status: VerifyStatus; reason?: string; httpStatus?: number } {
  if (!probe) return { status: "dead", reason: "network error / timeout" };
  if (probe.status >= 400 || probe.status === 0) return { status: "dead", reason: `HTTP ${probe.status}`, httpStatus: probe.status };
  if (looksBlocked(probe.body)) return { status: "blocked", reason: "anti-bot challenge in response", httpStatus: probe.status };
  if (probe.body.trim().length === 0 && probe.status !== 204) return { status: "dead", reason: "empty body", httpStatus: probe.status };
  return { status: "verified", httpStatus: probe.status };
}

/**
 * Verify each tool against the live site via `probe`. Bounded concurrency keeps it polite. Returns a report
 * with an honest three-way split and a `generalized` count for tools proven on a fresh, un-captured value.
 */
export async function verifyTools(
  tools: ToolDefinition[],
  probe: ProbeFn,
  opts: { freshValues?: Record<string, string> } = {},
): Promise<VerifyReport> {
  const verifications: ToolVerification[] = [];
  for (const tool of tools) {
    const t = verificationTargets(tool, opts.freshValues);
    if (t.skip || !t.captured) {
      verifications.push({ name: tool.name, status: "not_verifiable", reason: t.skip ?? "no target" });
      continue;
    }
    const capturedResult = classify(await probe(t.captured.url, t.captured.method));
    const v: ToolVerification = { name: tool.name, status: capturedResult.status, reason: capturedResult.reason, httpStatus: capturedResult.httpStatus, target: t.captured.url };
    // The generalization proof: a fresh, never-captured value must ALSO return real content.
    if (capturedResult.status === "verified" && t.fresh) {
      const freshResult = classify(await probe(t.fresh.url, t.fresh.method));
      v.generalized = freshResult.status === "verified";
      if (!v.generalized) v.reason = `captured ok but fresh value '${t.fresh.value}' -> ${freshResult.reason ?? freshResult.status}`;
    }
    verifications.push(v);
  }
  return {
    verifications,
    verified: verifications.filter((x) => x.status === "verified").length,
    dead: verifications.filter((x) => x.status === "dead").length,
    blocked: verifications.filter((x) => x.status === "blocked").length,
    notVerifiable: verifications.filter((x) => x.status === "not_verifiable").length,
    generalized: verifications.filter((x) => x.generalized).length,
  };
}

/**
 * Annotate a tool's confidence from its verification (pure; ANNOTATE, never prune). A live-verified tool is
 * trustworthy (floor its confidence up, higher when the template generalized); a dead/blocked tool is damped
 * so the registry can sort it down without losing it.
 */
export function annotateConfidence(tool: ToolDefinition, v: ToolVerification): ToolDefinition {
  if (v.status === "verified") {
    const floor = v.generalized ? 0.9 : 0.8;
    return tool.confidence >= floor ? tool : { ...tool, confidence: floor };
  }
  if (v.status === "dead" || v.status === "blocked") {
    return { ...tool, confidence: Math.min(tool.confidence, 0.3) };
  }
  return tool;
}

/**
 * Verify a toolset live and return confidence-ANNOTATED tools alongside the report (verified tools floored
 * up, dead/blocked damped, others untouched). Never prunes. The integration entry point for the pipeline.
 */
export async function verifyAndAnnotate(
  tools: ToolDefinition[],
  probe: ProbeFn,
  opts: { freshValues?: Record<string, string> } = {},
): Promise<{ tools: ToolDefinition[]; report: VerifyReport }> {
  const report = await verifyTools(tools, probe, opts);
  const byName = new Map(report.verifications.map((v) => [v.name, v]));
  const annotated = tools.map((t) => {
    const v = byName.get(t.name);
    return v ? annotateConfidence(t, v) : t;
  });
  return { tools: annotated, report };
}

/**
 * Verify live, then drop the `dead` tools (404/network-error/empty body on their own captured URL). `blocked`
 * (may work in the user's session) and `not_verifiable` (writes, browser, placeholder) are kept + annotated.
 * Returns kept tools, dropped names+reasons, and the report.
 */
export async function verifyAndFilter(
  tools: ToolDefinition[],
  probe: ProbeFn,
  opts: { freshValues?: Record<string, string>; dropBlocked?: boolean } = {},
): Promise<{ tools: ToolDefinition[]; dropped: Array<{ name: string; status: VerifyStatus; reason?: string }>; report: VerifyReport }> {
  const { tools: annotated, report } = await verifyAndAnnotate(tools, probe, opts);
  const byName = new Map(report.verifications.map((v) => [v.name, v]));
  const kept: ToolDefinition[] = [];
  const dropped: Array<{ name: string; status: VerifyStatus; reason?: string }> = [];
  for (const tool of annotated) {
    const v = byName.get(tool.name);
    const isDead = v?.status === "dead" || (opts.dropBlocked && v?.status === "blocked");
    if (isDead) dropped.push({ name: tool.name, status: v!.status, reason: v!.reason });
    else kept.push(tool);
  }
  return { tools: kept, dropped, report };
}

/** Bounded, GET/HEAD-only live probe for production/CLI use. Never throws; returns null on any failure. */
export function httpProbe(opts: { timeoutMs?: number; maxBytes?: number } = {}): ProbeFn {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 200_000;
  return async (url, method) => {
    if (!/^https?:\/\//i.test(url) || (method !== "GET" && method !== "HEAD")) return null;
    try {
      await assertPublicHttpUrl(url);
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        headers: { accept: "text/html,application/json,*/*", "user-agent": "Mozilla/5.0 (compatible; urlmcp-verify/1.0)" },
      });
      const body = method === "HEAD" ? "" : await readResponseTextWithLimit(res, maxBytes);
      return { status: res.status, body };
    } catch {
      return null;
    }
  };
}
