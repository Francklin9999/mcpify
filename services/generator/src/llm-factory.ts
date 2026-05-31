/**
 * LLM factory — reads LLM_PROVIDER from env and returns the right inference + heal clients.
 *
 * LLM_PROVIDER=openai  (default) → requires OPENAI_API_KEY
 * LLM_PROVIDER=claude             → requires ANTHROPIC_API_KEY
 * LLM_PROVIDER=gemini             → requires GEMINI_API_KEY
 *
 * Falls back to the keyless heuristic when no matching API key is set.
 */
import type { InferenceClient } from "./inference.js";
import type { HealClient } from "./self-heal.js";
import { OpenAIInferenceClient, OpenAIHealClient } from "./openai-client.js";
import { ClaudeInferenceClient, ClaudeHealClient } from "./claude-client.js";
import { GeminiInferenceClient, GeminiHealClient } from "./gemini-client.js";
import { HeuristicInferenceClient, HeuristicHealClient } from "./heuristic-inference.js";

export type LLMProvider = "openai" | "claude" | "gemini" | "heuristic";

export function activeLLMProvider(): LLMProvider {
  const p = (process.env["LLM_PROVIDER"] ?? "openai").toLowerCase();
  if (p === "claude" && process.env["ANTHROPIC_API_KEY"]) return "claude";
  if (p === "gemini" && process.env["GEMINI_API_KEY"]) return "gemini";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  return "heuristic";
}

export function activeModelVersion(): string {
  const provider = activeLLMProvider();
  if (provider === "claude") return `claude/${process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6"}`;
  if (provider === "gemini") return `gemini/${process.env["GEMINI_MODEL"] || "gemini-3.1-pro-preview"}`;
  if (provider === "openai") return `openai/${process.env["OPENAI_MODEL"] || "gpt-5.4"}`;
  return "heuristic/v1";
}

export function makeLLMClients(): { inference: InferenceClient; heal: HealClient; provider: LLMProvider } {
  const provider = activeLLMProvider();

  switch (provider) {
    case "claude":
      console.log(`[llm] provider=claude model=${process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6"}`);
      return { inference: new ClaudeInferenceClient(), heal: new ClaudeHealClient(), provider };
    case "gemini":
      console.log(`[llm] provider=gemini model=${process.env["GEMINI_MODEL"] || "gemini-3.1-pro-preview"}`);
      return { inference: new GeminiInferenceClient(), heal: new GeminiHealClient(), provider };
    case "openai":
      console.log(`[llm] provider=openai model=${process.env["OPENAI_MODEL"] || "gpt-5.4"}`);
      return { inference: new OpenAIInferenceClient(), heal: new OpenAIHealClient(), provider };
    default:
      console.warn("[llm] no API key configured — using keyless heuristic inference");
      return { inference: new HeuristicInferenceClient(), heal: new HeuristicHealClient(), provider };
  }
}
