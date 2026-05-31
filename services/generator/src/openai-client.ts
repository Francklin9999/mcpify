import OpenAI from "openai";
import type { CaptureBundle, ToolDefinition, ToolFailure } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { DiscoveryDelta } from "./incremental.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";

/**
 * Real OpenAI-backed InferenceClient. NOTE: this file is compiled but NOT unit-tested (tests mock the
 * port). Uses JSON mode (`response_format: json_object`) so the model is forced to emit parseable JSON;
 * the model is configurable via OPENAI_MODEL (default gpt-4o). Prompt caching on OpenAI is automatic for
 * long stable prefixes — no per-message flag needed.
 *
 * JSON mode cannot return a bare array, so we ask for `{ "tools": [...] }` — inference.ts already accepts
 * that shape as well as a bare array.
 */
// gpt-5.4: stronger tool/structured-output inference than gpt-4o. Override via OPENAI_MODEL.
// NOTE: gpt-5.x uses max_completion_tokens (rejects max_tokens).
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
const REASONING = process.env.OPENAI_REASONING;

const SYSTEM_PROMPT = `You convert observed website structure and traffic into MCP tool definitions.
Given a page URL, normalized HTML analysis, selectors, and observed network calls, output ONLY a JSON object of the form
{ "tools": [ <tool>, ... ] }. Each tool: { "name": snake_case, "description": string,
"inputSchema": <JSON Schema object>, "execution": either
{ "kind": "http", "request": <the NetworkCapture>,
"paramMapping": { param: { "in": "path"|"query"|"header"|"body", "key": string } } }
or
{ "kind": "browser", "steps": [
  { "action": "navigate", "value": "https://..." },
  { "action": "fill"|"click"|"waitFor"|"extract", "target": { "role": string, "selector": string, "fallbackSelectors"?: string[] }, "value"?: string }
] },
"confidence": number in [0,1] }.
Prefer tools that map to real user tasks: search, list results, fetch detail pages, filters, pagination,
and structured extraction. Prefer observed network calls when available. Otherwise derive safe public GET/POST
tools or browser-step tools from visible forms, page selectors, canonical links, repeated detail-link patterns,
and app-state hints in pageAnalysis. Use browser tools when the page is JS-driven or when the output should be
structured JSON. For browser extract steps, prefer value "json:metadata", "json:product", or "json:listing".
Skip login, password, checkout, account, and credential/session-only actions. Output JSON only, no prose.`;

export class OpenAIInferenceClient implements InferenceClient {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 16000,
      ...(REASONING ? { reasoning_effort: REASONING as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            url: bundle.url,
            pageAnalysis: analyzeBundleHtml(bundle),
            // Keep a small raw slice for unusual markup the analyzer missed.
            domSample: bundle.dom.html.slice(0, 8000),
            selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
            network: bundle.network,
          }),
        },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }

  /**
   * Incremental discovery (`incremental.ts`): the user payload is ONLY the new material (delta) plus the
   * names of tools that already exist — never the whole page again. This is the token-efficient
   * "continuously generate more" path. Reuses SYSTEM_PROMPT for the exact tool shape; adds the extend-only
   * framing so the model proposes only genuinely-new capabilities (no synonyms of existing tools).
   */
  async proposeMoreTools(delta: DiscoveryDelta): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 8000,
      ...(REASONING ? { reasoning_effort: REASONING as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n${INCREMENTAL_NOTE}` },
        { role: "user", content: JSON.stringify(delta) },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
}

const INCREMENTAL_NOTE = `INCREMENTAL MODE: you are EXTENDING an existing MCP server. The payload contains only NEW
page material discovered since the last pass, plus "knownToolNames" — tools that ALREADY exist. Propose ONLY
genuinely-new, distinct capabilities for the new material. Do NOT restate, rename, or duplicate an existing
tool (e.g. do not add "find_products" when "search_products" already exists). If nothing is genuinely new,
output { "tools": [] }.`;

const HEAL_SYSTEM_PROMPT = `You repair a single broken MCP tool. Given the current (broken) tool, a fresh
DOM/network snapshot of its source page, and the observed failure, output ONLY the corrected tool as a
single JSON object with the SAME "name". Keep the same shape as the input tool; fix the selector, request,
or paramMapping that broke. Output JSON only, no prose.`;

/** Real OpenAI-backed HealClient. Compiled but not unit-tested (tests mock the port). */
export class OpenAIHealClient implements HealClient {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeHeal(failingTool: ToolDefinition, bundle: CaptureBundle, failure: ToolFailure): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 8000,
      ...(REASONING ? { reasoning_effort: REASONING as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: HEAL_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            brokenTool: failingTool,
            failure,
            snapshot: {
              url: bundle.url,
              dom: bundle.dom.html.slice(0, 20000),
              selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
              network: bundle.network,
            },
          }),
        },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
}
