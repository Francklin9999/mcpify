import OpenAI from "openai";
import type { CaptureBundle } from "@mcp/types";
import { type InferenceClient, TOOL_SYSTEM_PROMPT } from "@mcp/generator/lean";
import { buildInferencePayload } from "./inference-clients.js";

/**
 * ONE client for EVERY OpenAI-compatible endpoint (OpenAI, Groq, Together, OpenRouter, DeepSeek, Mistral,
 * Fireworks, xAI, Ollama, LM Studio, vLLM, ... - see providers.ts). The only difference between providers is
 * (baseURL, apiKey, model); the request shape is identical, which is exactly why this single adapter replaces
 * a pile of per-provider clients. Mirrors the generator's proven OpenAI invocation (same system prompt + page
 * payload) but uses the broadly-portable `max_tokens` and degrades gracefully when a provider rejects
 * `response_format` - so it works across the widest set of endpoints.
 */
// Output token cap. 16000 is fine for hosted models but can exceed a LOCAL model's whole context window
// (Ollama/LM Studio are often 8k), so default conservatively and let power users raise it via FORGE_MAX_TOKENS.
const MAX_TOKENS = Number(process.env["FORGE_MAX_TOKENS"]) || 8192;

export class OpenAICompatibleInferenceClient implements InferenceClient {
  private readonly client: OpenAI;
  /** Memoized after the first rejection: this provider/model can't do JSON mode, so stop sending it. */
  private jsonModeUnsupported = false;
  constructor(
    private readonly model: string,
    opts: { baseURL?: string; apiKey: string },
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const messages = [
      { role: "system" as const, content: TOOL_SYSTEM_PROMPT },
      { role: "user" as const, content: JSON.stringify(buildInferencePayload(bundle)) },
    ];
    const base = { model: this.model, max_tokens: MAX_TOKENS, messages };
    // Prefer JSON mode, but some OpenAI-compatible providers/models don't support response_format and 400.
    // The first time that happens we retry without it AND remember it, so we don't re-pay the reject round
    // trip on every later call (TOOL_SYSTEM_PROMPT already instructs the model to emit JSON).
    if (this.jsonModeUnsupported) {
      const res = await this.client.chat.completions.create(base);
      return res.choices[0]?.message?.content ?? "[]";
    }
    try {
      const res = await this.client.chat.completions.create({ ...base, response_format: { type: "json_object" } });
      return res.choices[0]?.message?.content ?? "[]";
    } catch (err) {
      if (!isJsonModeRejection(err)) throw err;
      this.jsonModeUnsupported = true;
      const res = await this.client.chat.completions.create(base);
      return res.choices[0]?.message?.content ?? "[]";
    }
  }
}

/** A 400/422 about JSON mode means the provider/model can't do response_format; everything else re-throws. */
function isJsonModeRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const msg = String((err as { message?: string })?.message ?? "").toLowerCase();
  return msg.includes("response_format") || msg.includes("json_object") || msg.includes("json mode") || msg.includes("json schema");
}
