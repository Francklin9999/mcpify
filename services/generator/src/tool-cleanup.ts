import type { ToolDefinition } from "@mcp/types";

/**
 * Final pure pass over a validated tool list, applied at the inference chokepoint (`inferTools`, and the
 * incremental `discoverMore`) so EVERY artifact-producing path benefits. It fixes two classes of defect the
 * upstream miners leave behind:
 *
 *  1. Mis-mined noise tools. The query-link miner turns a page's `Sign in` / `Sign up` link into a
 *     `browse_listing GET /login?return_to=…` tool; dynamic (React/Next/SPA) apps additionally spray
 *     telemetry/RUM beacons and liveness probes (`telemetry.…/settings`, `/isalive`) that the source-side
 *     noise filter misses for less-common vendors. None can be driven as a data tool - pure noise that makes
 *     a server look like it "calls the same thing over and over". Drops auth flows, infra/telemetry hosts,
 *     and health probes (aligning with the existing stance of skipping login/auth FORMS).
 *
 *  2. A percent-encoded path placeholder in a browser navigate step. When a detail template like
 *     `/catalogue/{id}/index.html` is run through `new URL().toString()`, `{id}` becomes `%7Bid%7D`; the
 *     runtime's `{param}`/`{{param}}` substitution then can't see it and the tool navigates to a literal
 *     `%7Bid%7D` URL (a dead tool). Decoding the braces back makes the placeholder substitutable again.
 *
 * Pure and conservative: it never drops the content-fetch floor or the page the user actually captured, and
 * it returns a new array (no mutation of the validated inputs). It MAY return empty (e.g. an incremental
 * delta that was all auth junk); callers that must guarantee a non-empty server (`inferTools`) re-apply the
 * content floor afterward.
 */

// Auth/account-flow path SEGMENTS. Segment-anchored so it can't swallow a legitimate detail page like
// `/user/{id}` or `/account/{id}` - only whole segments such as `/login` or `/users/signup` match.
const AUTH_PATH_RE = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|sign[-_]?up|signin|signup|register|logout|sso|oauth2?|password[-_]?reset)(?:\/|$)/i;

// SaaS/infra endpoints that fire as XHR but are NEVER a site's data API. Dynamic (React/Next/SPA) apps spray
// these on load: liveness/health probes and telemetry/RUM/monitoring hosts. The less-common vendors slip past
// the source-side noise filter (e.g. telemetry.algolia.com's /1/settings, an /isalive probe) and would
// otherwise ship as junk tools. Path probes are segment-anchored so a real `/healthcare/{id}` page is safe.
const PROBE_PATH_RE = /(?:^|\/)(?:isalive|alive|health(?:z|check)?|ping|heartbeat|liveness|readiness)(?:\/|$)/i;
const INFRA_HOST_RE = /(?:^|\.)(?:telemetry|rum|metrics|beacon|stats|sentry|datadog|newrelic|nr-data|amplitude|mixpanel|track(?:ing)?)\./i;

// Tools that are always kept regardless of where they point (the floor + the page-level metadata tool).
const PROTECTED_NAMES = new Set(["fetch_page_content", "extract_page_metadata"]);

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function pagePath(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).pathname || "/";
  } catch {
    return null;
  }
}

/** Decode the percent-encoded braces a placeholder picks up from URL normalization (`%7Bid%7D` -> `{id}`). */
function repairPlaceholders(value: string): string {
  return value.includes("%7B") || value.includes("%7b") ? value.replace(/%7[Bb]/g, "{").replace(/%7[Dd]/g, "}") : value;
}

function repairTool(tool: ToolDefinition): ToolDefinition {
  if (tool.execution.kind !== "browser") return tool;
  let changed = false;
  const steps = tool.execution.steps.map((step) => {
    if (typeof step.value !== "string") return step;
    const repaired = repairPlaceholders(step.value);
    if (repaired === step.value) return step;
    changed = true;
    return { ...step, value: repaired };
  });
  return changed ? { ...tool, execution: { ...tool.execution, steps } } : tool;
}

/**
 * A mis-mined, never-useful HTTP tool: an auth/account flow, a SaaS telemetry/monitoring host, or a
 * liveness/health probe. Never drops the content floor or the page the user actually captured.
 */
function isJunkTool(tool: ToolDefinition, capturedPath: string | null): boolean {
  if (PROTECTED_NAMES.has(tool.name)) return false;
  if (tool.execution.kind !== "http") return false;
  const pattern = tool.execution.request.urlPattern;
  if (capturedPath && pattern === capturedPath) return false; // never drop the page the user captured
  if (AUTH_PATH_RE.test(pattern) || PROBE_PATH_RE.test(pattern)) return true;
  return INFRA_HOST_RE.test(hostOf(tool.execution.request.rawUrl));
}

/**
 * Clean a validated tool list: repair encoded placeholders, then drop mis-mined auth/account navigation.
 * May return empty if every tool was auth junk - callers needing a guaranteed tool re-apply the floor.
 */
export function cleanupTools(tools: ToolDefinition[], pageUrl: string): ToolDefinition[] {
  const capturedPath = pagePath(pageUrl);
  return tools.map(repairTool).filter((tool) => !isJunkTool(tool, capturedPath));
}
