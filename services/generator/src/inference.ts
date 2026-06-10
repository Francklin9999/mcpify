import { CaptureBundle, InferenceResult, ToolDefinition, aggregateConfidence } from "@mcp/types";
import { siteRecipeTools } from "./site-recipes.js";
import { cleanupTools } from "./tool-cleanup.js";
import type { DiscoveryDelta } from "./incremental.js";

/**
 * Inference: CaptureBundle -> validated ToolDefinition[]. The model call is behind InferenceClient (testable
 * with zero network). The core job is the validation gate: parse JSON, drop tools failing the contract, dedup.
 */

/** Baseline content tool, synthesized from the bundle URL - the floor applied when inference yields nothing. */
export function contentToolFor(bundle: CaptureBundle): ToolDefinition {
  let path = "/";
  try {
    path = new URL(bundle.url).pathname || "/";
  } catch {
    /* keep "/" */
  }
  return ToolDefinition.parse({
    name: "fetch_page_content",
    description: `Fetch the page content (HTML) from ${bundle.url}${bundle.meta.title ? ` - ${bundle.meta.title}` : ""}.`,
    inputSchema: { type: "object", properties: {} },
    execution: {
      kind: "http",
      request: {
        method: "GET",
        urlPattern: path,
        rawUrl: bundle.url,
        requestHeaders: { accept: "text/html" },
        statusCode: 200,
        contentType: "text/html",
      },
      paramMapping: {},
    },
    confidence: 0.5,
  });
}
export interface InferenceClient {
  /** Returns the model's raw JSON text proposing tools (an array, or `{ tools: [...] }`). */
  proposeTools(bundle: CaptureBundle): Promise<string>;
  /** Optional incremental proposal over the delta only; clients that omit it fall back to proposeTools. */
  proposeMoreTools?(delta: DiscoveryDelta): Promise<string>;
}

export interface InferenceOutcome {
  result: InferenceResult;
  /** How many candidate tools failed contract validation and were dropped. */
  droppedCount: number;
}

/** Parse a model's raw JSON proposal into a candidate array (accepts a bare array or `{ tools: [...] }`). */
export function parseCandidates(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown }).tools)) {
      return (parsed as { tools: unknown[] }).tools;
    }
  } catch {
    /* non-JSON model output -> zero candidates, never throw (worker stays alive) */
  }
  return [];
}

export interface ValidateOptions {
  /** Names already taken - a candidate reusing one is dropped (dedup across an existing toolset). */
  seenNames?: Iterable<string>;
  /** Extra drop predicate, e.g. incremental discovery dropping a candidate that targets an already-covered endpoint. */
  dropIf?: (tool: ToolDefinition) => boolean;
}

function executionSignature(tool: ToolDefinition): string {
  if (tool.execution.kind === "http") {
    const mapping = Object.entries(tool.execution.paramMapping)
      .map(([name, value]) => `${name}:${value.in}:${value.key}`)
      .sort()
      .join(",");
    return [
      "http",
      tool.execution.request.method.toUpperCase(),
      tool.execution.request.urlPattern,
      mapping,
    ].join("|");
  }
  return `browser|${JSON.stringify(tool.inputSchema)}|${JSON.stringify(tool.execution.steps)}`;
}

/**
 * The validation gate: parse -> contract-validate -> dedup by name and execution signature -> optional drop.
 * Pure; never throws on garbage.
 */
export function validateCandidates(candidates: unknown[], opts: ValidateOptions = {}): { tools: ToolDefinition[]; droppedCount: number } {
  const tools: ToolDefinition[] = [];
  let droppedCount = 0;
  const seen = new Set<string>(opts.seenNames ?? []);
  const seenExecutions = new Set<string>();
  for (const candidate of candidates) {
    const parsed = ToolDefinition.safeParse(candidate);
    if (!parsed.success) {
      droppedCount++;
      continue;
    }
    if (seen.has(parsed.data.name)) {
      droppedCount++;
      continue;
    }
    if (opts.dropIf && opts.dropIf(parsed.data)) {
      droppedCount++;
      continue;
    }
    const signature = executionSignature(parsed.data);
    if (seenExecutions.has(signature)) {
      droppedCount++;
      continue;
    }
    seen.add(parsed.data.name);
    seenExecutions.add(signature);
    tools.push(parsed.data);
  }
  return { tools, droppedCount };
}

function activeModelVersion(): string {
  const p = (process.env["LLM_PROVIDER"] ?? "openai").toLowerCase();
  if (p === "claude") return `claude/${process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6"}`;
  if (p === "gemini") return `gemini/${process.env["GEMINI_MODEL"] || "gemini-3.1-pro-preview"}`;
  return `openai/${process.env["OPENAI_MODEL"] || "gpt-5.4"}`;
}

export async function inferTools(
  bundle: CaptureBundle,
  client: InferenceClient,
  modelVersion = activeModelVersion(),
): Promise<InferenceOutcome> {
  const raw = await client.proposeTools(bundle);
  // Recipes first, so a bot-walled / weak snapshot still yields the obvious deterministic tools.
  const candidates = [...siteRecipeTools(bundle), ...parseCandidates(raw)];
  const { tools, droppedCount } = validateCandidates(candidates);

  const cleaned = cleanupTools(tools, bundle.url);
  // Floor (after cleanup): never ship a zero-tool server.
  if (cleaned.length === 0) cleaned.push(contentToolFor(bundle));

  const confidence = aggregateConfidence(cleaned.map((t) => t.confidence));
  const result = InferenceResult.parse({
    url: bundle.url,
    bundleId: bundle.bundleId,
    tools: cleaned,
    confidence,
    modelVersion,
  });
  return { result, droppedCount };
}
