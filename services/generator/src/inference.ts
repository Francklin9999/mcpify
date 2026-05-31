import { CaptureBundle, InferenceResult, ToolDefinition, aggregateConfidence } from "@mcp/types";
import { siteRecipeTools } from "./site-recipes.js";
import type { DiscoveryDelta } from "./incremental.js";

/**
 * Inference: CaptureBundle -> validated ToolDefinition[] (`01 S2`, `services/generator.md`).
 * The model call lives behind `InferenceClient` so this module is testable with zero network.
 * This module's real job is the VALIDATION GATE: parse the model's JSON, drop tools that fail the
 * contract zod, dedup by name, and never crash on garbage output.
 */

/**
 * Baseline content tool, synthesized from the bundle URL. Floor applied by `inferTools` when an inference
 * source returns zero usable tools (e.g. a content site with no API traffic, or a model that emitted
 * nothing valid). Guarantees every site yields a usable, runnable server instead of a broken zero-tool one.
 * Source-agnostic: applies to heuristic, OpenAI, and Claude paths alike.
 */
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
  /**
   * Optional INCREMENTAL proposal: given only newly-discovered page material (the delta) plus the names of
   * tools already produced, propose ADDITIONAL distinct tools - same JSON-string shape as `proposeTools`.
   * This is the token-efficient path: the model never re-sees material it already turned into tools.
   * Clients that omit it fall back (in `discoverMore`) to a `proposeTools` call over a delta-only bundle.
   */
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

/**
 * The VALIDATION GATE shared by full and incremental inference: parse -> contract-validate -> dedup by name
 * (MCP registerTool throws on a duplicate; DB tools PK is (server_id, version, name)) -> optional drop. Pure;
 * never throws on garbage.
 */
export function validateCandidates(candidates: unknown[], opts: ValidateOptions = {}): { tools: ToolDefinition[]; droppedCount: number } {
  const tools: ToolDefinition[] = [];
  let droppedCount = 0;
  const seen = new Set<string>(opts.seenNames ?? []);
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
    seen.add(parsed.data.name);
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
  // Site recipes are merged first so a bot-walled / weak snapshot still yields the obvious deterministic tools.
  const candidates = [...siteRecipeTools(bundle), ...parseCandidates(raw)];
  const { tools, droppedCount } = validateCandidates(candidates);

  // Floor: never ship a zero-tool (broken) server - give every site the content-fetch baseline.
  if (tools.length === 0) tools.push(contentToolFor(bundle));

  const confidence = aggregateConfidence(tools.map((t) => t.confidence));
  const result = InferenceResult.parse({
    url: bundle.url,
    bundleId: bundle.bundleId,
    tools,
    confidence,
    modelVersion,
  });
  return { result, droppedCount };
}
