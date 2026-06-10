import OpenAI from "openai";
import type { CaptureBundle, ToolDefinition, ToolFailure } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { DiscoveryDelta } from "./incremental.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";
import { TOOL_SYSTEM_PROMPT, INCREMENTAL_NOTE, HEAL_SYSTEM_PROMPT } from "./llm-prompts.js";

/**
 * OpenAI-backed InferenceClient. Uses JSON mode (response_format: json_object) for parseable output, asking
 * for `{ "tools": [...] }` (inference.ts accepts that or a bare array). Model via OPENAI_MODEL.
 */
// gpt-5.4: stronger tool/structured-output inference than gpt-4o. Override via OPENAI_MODEL.
// NOTE: gpt-5.x uses max_completion_tokens (rejects max_tokens).
const DEFAULT_MODEL = process.env["OPENAI_MODEL"] || "gpt-5.4";
const REASONING = process.env["OPENAI_REASONING"];
const LLM_REQUEST_TIMEOUT_MS = Number(process.env["LLM_REQUEST_TIMEOUT_MS"] || 120_000);

export class OpenAIInferenceClient implements InferenceClient {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        max_completion_tokens: 16000,
        ...(REASONING ? { reasoning_effort: REASONING as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: TOOL_SYSTEM_PROMPT },
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
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return res.choices[0]?.message?.content ?? "";
  }

  /**
   * Incremental discovery (`incremental.ts`): the user payload is ONLY the new material (delta) plus the
   * names of tools that already exist - never the whole page again. This is the token-efficient
   * "continuously generate more" path. Reuses SYSTEM_PROMPT for the exact tool shape; adds the extend-only
   * framing so the model proposes only genuinely-new capabilities (no synonyms of existing tools).
   */
  async proposeMoreTools(delta: DiscoveryDelta): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        max_completion_tokens: 8000,
        ...(REASONING ? { reasoning_effort: REASONING as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${TOOL_SYSTEM_PROMPT}\n\n${INCREMENTAL_NOTE}` },
          { role: "user", content: JSON.stringify(delta) },
        ],
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return res.choices[0]?.message?.content ?? "";
  }
}

/** Real OpenAI-backed HealClient. Compiled but not unit-tested (tests mock the port). */
export class OpenAIHealClient implements HealClient {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeHeal(failingTool: ToolDefinition, bundle: CaptureBundle, failure: ToolFailure): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
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
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return res.choices[0]?.message?.content ?? "";
  }
}
