import type { ToolDefinition } from "@mcp/types";

/**
 * Final pure pass over a validated tool list (at inferTools + discoverMore). Drops mis-mined noise tools
 * (auth/account flows, telemetry/monitoring hosts, health probes) and repairs percent-encoded placeholders
 * (`%7Bid%7D` -> `{id}`) in browser navigate steps. Never drops the content floor or the captured page; may
 * return empty (callers re-apply the floor).
 */

// Auth/account-flow segments. Segment-anchored so a real /user/{id} or /account/{id} isn't swallowed.
const AUTH_PATH_RE = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|sign[-_]?up|signin|signup|register|logout|sso|oauth2?|password[-_]?reset)(?:\/|$)/i;

// Liveness/health probes - segment-anchored so a real /healthcare/{id} is safe.
const PROBE_PATH_RE = /(?:^|\/)(?:isalive|alive|health(?:z|check)?|ping|heartbeat|liveness|readiness)(?:\/|$)/i;
// Unambiguous monitoring/analytics vendor hosts only (excludes generic stats./metrics./track. used by real APIs).
const INFRA_HOST_RE = /(?:^|\.)(?:telemetry|rum|beacon|sentry|datadog|newrelic|nr-data|amplitude|mixpanel)\./i;

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

/** Decode percent-encoded placeholder braces from URL normalization (`%7Bid%7D` -> `{id}`). */
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

/** A mis-mined, never-useful HTTP tool: auth flow, telemetry/monitoring host, or health probe. */
function isJunkTool(tool: ToolDefinition, capturedPath: string | null): boolean {
  if (PROTECTED_NAMES.has(tool.name)) return false;
  if (tool.execution.kind !== "http") return false;
  const pattern = tool.execution.request.urlPattern;
  if (capturedPath && pattern === capturedPath) return false; // never drop the page the user captured
  if (AUTH_PATH_RE.test(pattern) || PROBE_PATH_RE.test(pattern)) return true;
  return INFRA_HOST_RE.test(hostOf(tool.execution.request.rawUrl));
}

/** Repair encoded placeholders, then drop mis-mined junk. May return empty (callers re-apply the floor). */
export function cleanupTools(tools: ToolDefinition[], pageUrl: string): ToolDefinition[] {
  const capturedPath = pagePath(pageUrl);
  return tools.map(repairTool).filter((tool) => !isJunkTool(tool, capturedPath));
}
