import Anthropic from "@anthropic-ai/sdk";
import type { CaptureBundle, ToolDefinition, ToolFailure } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { DiscoveryDelta } from "./incremental.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";
import { TOOL_SYSTEM_PROMPT, INCREMENTAL_NOTE, HEAL_SYSTEM_PROMPT } from "./llm-prompts.js";

const DEFAULT_MODEL = process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6";
const LLM_REQUEST_TIMEOUT_MS = Number(process.env["LLM_REQUEST_TIMEOUT_MS"] || 120_000);

// Prompt caching: mark the stable system prompt so repeated calls hit the cache.
const CACHED_SYSTEM: Anthropic.Messages.TextBlockParam & { cache_control: { type: "ephemeral" } } = {
  type: "text",
  text: TOOL_SYSTEM_PROMPT,
  cache_control: { type: "ephemeral" },
};

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Claude-backed InferenceClient. Uses a JSON-prefill assistant turn so the model is forced to emit
 * valid JSON - more reliable than asking Claude to "output JSON only" in the system prompt alone.
 * Prompt caching is enabled on the system prompt (ephemeral, 5-min TTL).
 */
export class ClaudeInferenceClient implements InferenceClient {
  constructor(
    private readonly client = new Anthropic(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const msg = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16000,
        system: [CACHED_SYSTEM],
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              url: bundle.url,
              pageAnalysis: analyzeBundleHtml(bundle),
              domSample: bundle.dom.html.slice(0, 8000),
              selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
              network: bundle.network,
            }),
          },
          // Prefill forces Claude to continue a valid JSON object - no prose preamble possible.
          { role: "assistant", content: '{"tools":' },
        ],
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return '{"tools":' + extractText(msg.content);
  }

  async proposeMoreTools(delta: DiscoveryDelta): Promise<string> {
    const msg = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 8000,
        system: [{ type: "text", text: `${TOOL_SYSTEM_PROMPT}\n\n${INCREMENTAL_NOTE}`, cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: JSON.stringify(delta) },
          { role: "assistant", content: '{"tools":' },
        ],
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return '{"tools":' + extractText(msg.content);
  }
}

/** Claude-backed HealClient. */
export class ClaudeHealClient implements HealClient {
  constructor(
    private readonly client = new Anthropic(),
    private readonly model = DEFAULT_MODEL,
  ) {}

  async proposeHeal(failingTool: ToolDefinition, bundle: CaptureBundle, failure: ToolFailure): Promise<string> {
    const msg = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 8000,
        system: [{ type: "text", text: HEAL_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
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
          { role: "assistant", content: '{"name":' },
        ],
      },
      { timeout: LLM_REQUEST_TIMEOUT_MS },
    );
    return '{"name":' + extractText(msg.content);
  }
}
