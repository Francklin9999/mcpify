import type { CaptureBundle, NetworkCapture, ToolDefinition } from "@mcp/types";
import { analyzeBundleHtml, type DetailLinkPattern, type QueryLinkPattern, type SearchActionPattern } from "./html-analysis.js";
import { parseCandidates, validateCandidates, type InferenceClient } from "./inference.js";

/**
 * Incremental tool discovery (`continuous generation`). As a reactive page changes, new structure appears -
 * a new endpoint fires, a new form/list/detail-pattern renders. This module finds the tools for ONLY that
 * new material and merges them into an existing toolset, so:
 *   - the model is never re-sent material it already turned into tools (token budget), and
 *   - when nothing new appeared, NO model call happens at all (`calledModel:false`).
 *
 * It is PERSISTENCE-AGNOSTIC: the current toolset IS the state. Coverage (what's already tooled) is derived
 * from the existing tools' execution targets, so no extra per-server state or migration is needed for v1.
 */

/** What the existing toolset already targets. Templated so an infinite-scroll page's many product links
 *  collapse to ONE sig (`GET /item/{id}`), never an unbounded stream of "new" material. */
export interface Coverage {
  names: Set<string>;
  sigs: Set<string>;
}

const APPSTATE = "APPSTATE";

/** Templated path: strip query, normalize `{{x}}`->`{x}`, reduce absolute URLs to their pathname. */
function normalizePath(urlPattern: string): string {
  let path = String(urlPattern || "").replace(/\{\{(\w+)\}\}/g, "{$1}");
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  if (/^https?:/i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* keep as-is */
    }
  }
  if (!path) path = "/";
  if (!path.startsWith("/") && path !== APPSTATE) path = "/" + path;
  return path;
}

/** Structural signature of an endpoint/action: `METHOD templated-path`. Same endpoint => same sig. */
function sig(method: string, urlPattern: string): string {
  return `${String(method || "GET").toUpperCase()} ${normalizePath(urlPattern)}`;
}

/** First navigate target of a browser tool, as a sig (so browser shortcut tools count toward coverage). */
function browserSig(tool: ToolDefinition): string | undefined {
  if (tool.execution.kind !== "browser") return undefined;
  const nav = tool.execution.steps.find((s) => s.action === "navigate");
  return nav?.value ? sig("GET", nav.value) : undefined;
}

/** The endpoint sig a tool targets (for capability-dup detection), or "" if it has none. */
export function toolSig(tool: ToolDefinition): string {
  if (tool.execution.kind === "http") return sig(tool.execution.request.method, tool.execution.request.urlPattern);
  return browserSig(tool) ?? "";
}

export function coverageOf(tools: ToolDefinition[]): Coverage {
  const names = new Set<string>();
  const sigs = new Set<string>();
  for (const tool of tools) {
    names.add(tool.name);
    const s = toolSig(tool);
    if (s) sigs.add(s);
  }
  return { names, sigs };
}

/** The compact "new material" sent to the model in incremental mode (NOT the whole bundle). */
export interface DiscoveryDelta {
  url: string;
  /** Names of tools already produced - given to the model so it proposes only genuinely-new capabilities. */
  knownToolNames: string[];
  newNetwork: NetworkCapture[];
  newForms: unknown[];
  newDetailPatterns: DetailLinkPattern[];
  newQueryPatterns: QueryLinkPattern[];
  newSearchActions: SearchActionPattern[];
  newActions: { kind: string; label: string; selector: string; href?: string }[];
  /** Supporting context only - does NOT by itself trigger a model call. */
  newAppState: { source: string; keys: string[]; types: string[] }[];
}

/**
 * Diff a fresh capture against what's already covered. Returns only-new material + whether anything
 * tool-bearing is new (`hasNew`). App-state changes are surfaced as context but don't flip `hasNew` on their
 * own (they're hints, not endpoints - gating a paid call on them would be noisy).
 */
export function computeDelta(bundle: CaptureBundle, coverage: Coverage): { delta: DiscoveryDelta; hasNew: boolean } {
  const analysis = analyzeBundleHtml(bundle);
  const seen = new Set(coverage.sigs); // also dedups WITHIN the delta
  const fresh = (method: string, urlPattern: string): boolean => {
    const s = sig(method, urlPattern);
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  };

  const newNetwork = bundle.network.filter((c) => fresh(c.method, c.urlPattern));
  const newDetailPatterns = analysis.detailLinkPatterns.filter((p) => fresh("GET", p.urlPattern));
  const newQueryPatterns = analysis.queryLinkPatterns.filter((p) => fresh("GET", p.urlPattern));
  const newSearchActions = analysis.searchActions.filter((p) => fresh("GET", p.urlPattern));
  const forms = (bundle.page?.forms ?? []) as { method?: string; action?: string }[];
  const newForms = forms.filter((f) => fresh(f.method ?? "GET", f.action ?? bundle.url));
  const newAppState = (analysis.appStateHints ?? []).filter((h) => fresh(APPSTATE, h.source));
  const actionToolName = (label: string): string | undefined => {
    const text = label.toLowerCase();
    if (/\b(add to cart|add to basket)\b/.test(text)) return "add_to_cart";
    if (/\b(cart|basket|view cart)\b/.test(text)) return "open_cart";
    if (/\b(next|show more|load more|more results)\b/.test(text)) return "go_to_next_page";
    if (/\b(previous|prev|back results)\b/.test(text)) return "go_to_previous_page";
    return undefined;
  };
  const newActions = ((bundle.page?.actions ?? []) as Array<{ kind: string; label: string; selector: string; href?: string }>)
    .map((action) => ({ ...action, toolName: actionToolName(action.label) }))
    .filter((action) => action.toolName && !coverage.names.has(action.toolName))
    .slice(0, 8)
    .map(({ kind, label, selector, href }) => ({ kind, label, selector, href }));

  const delta: DiscoveryDelta = {
    url: bundle.url,
    knownToolNames: [...coverage.names],
    newNetwork,
    newForms,
    newDetailPatterns,
    newQueryPatterns,
    newSearchActions,
    newActions,
    newAppState,
  };
  const hasNew =
    newNetwork.length + newDetailPatterns.length + newQueryPatterns.length + newSearchActions.length + newForms.length + newActions.length > 0;
  return { delta, hasNew };
}

/**
 * Merge already-found `candidates` into `currentTools` WITHOUT any model call - dedup by name and by covered
 * endpoint sig. Used by the worker when a synchronous /api/discover pass already paid for the inference, so
 * persistence doesn't re-infer the same material.
 */
export function mergeCandidates(currentTools: ToolDefinition[], candidates: ToolDefinition[]): { tools: ToolDefinition[]; added: ToolDefinition[] } {
  const coverage = coverageOf(currentTools);
  const { tools: added } = validateCandidates(candidates, {
    seenNames: coverage.names,
    dropIf: (tool) => {
      const s = toolSig(tool);
      return s !== "" && coverage.sigs.has(s);
    },
  });
  return { tools: [...currentTools, ...added], added };
}

export interface DiscoverMoreOutcome {
  /** existing tools + the newly discovered ones. */
  tools: ToolDefinition[];
  /** only the new tools (empty when nothing new). */
  added: ToolDefinition[];
  droppedCount: number;
  /** false when there was no new material - no model call was made (zero tokens). */
  calledModel: boolean;
  delta: DiscoveryDelta;
}

/**
 * Discover ADDITIONAL tools from a new capture and merge them with `currentTools`. The paid path
 * (`client.proposeMoreTools`) is sent ONLY the delta; a client without it falls back to a full
 * `proposeTools` (fine for the free heuristic - the validator still filters down to genuinely-new tools).
 * New candidates are dropped if their name OR their endpoint sig already exists (kills synonym/duplicate
 * capabilities the more this runs).
 */
export async function discoverMore(
  currentTools: ToolDefinition[],
  bundle: CaptureBundle,
  client: InferenceClient,
): Promise<DiscoverMoreOutcome> {
  const coverage = coverageOf(currentTools);
  const { delta, hasNew } = computeDelta(bundle, coverage);
  if (!hasNew) {
    return { tools: currentTools, added: [], droppedCount: 0, calledModel: false, delta };
  }

  const raw = client.proposeMoreTools ? await client.proposeMoreTools(delta) : await client.proposeTools(bundle);
  const { tools: added, droppedCount } = validateCandidates(parseCandidates(raw), {
    seenNames: coverage.names,
    dropIf: (tool) => {
      const s = toolSig(tool);
      return s !== "" && coverage.sigs.has(s);
    },
  });

  return { tools: [...currentTools, ...added], added, droppedCount, calledModel: true, delta };
}
