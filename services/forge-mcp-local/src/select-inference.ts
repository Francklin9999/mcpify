import {
  type InferenceClient,
  ClaudeInferenceClient,
  GeminiInferenceClient,
  HeuristicInferenceClient,
} from "@mcp/generator/lean";
import { OpenAICompatibleInferenceClient } from "./openai-compatible-client.js";
import { HttpInferenceClient } from "./inference-clients.js";
import { resolveProvider } from "./providers.js";

/**
 * Server-side brain for forge_generate, selected by FORGE_INFERENCE (a provider name or `provider/model`):
 *   host (default)    - no server brain; the calling model infers the tools (heuristic fallback for forge_generate)
 *   heuristic         - keyless rule-based inference
 *   openai|groq|together|openrouter|deepseek|mistral|fireworks|xai - hosted OpenAI-compatible providers
 *   ollama|lmstudio|vllm - local OpenAI-compatible servers (no key)
 *   openai-compatible - any other endpoint via FORGE_OPENAI_BASE_URL
 *   claude|gemini     - native Anthropic / Google clients
 *   http              - your own endpoint (FORGE_INFERENCE_URL)
 * Anything missing its key falls back to the keyless heuristic.
 */
export interface SelectedInference {
  mode: string;
  /** What forge_generate will actually run with. */
  client: InferenceClient;
  /** Human-readable label for tool output, e.g. "Groq (llama-3.3-70b-versatile)". */
  label: string;
  /** True when the mode intends the *calling* model to do inference (scrape+emit), not the server. */
  hostBrain: boolean;
}

function heuristicFallback(reason: string): SelectedInference {
  return { mode: "heuristic", client: new HeuristicInferenceClient(), label: `heuristic (fallback: ${reason})`, hostBrain: false };
}

function parseHeaders(): Record<string, string> | undefined {
  const raw = process.env["FORGE_INFERENCE_HEADERS"];
  if (!raw) return undefined;
  try {
    const o: unknown = JSON.parse(raw);
    if (o && typeof o === "object") return o as Record<string, string>;
    console.error("[urlmcp] FORGE_INFERENCE_HEADERS must be a JSON object; ignoring it.");
    return undefined;
  } catch {
    console.error("[urlmcp] FORGE_INFERENCE_HEADERS is not valid JSON; ignoring it.");
    return undefined;
  }
}

export function selectInference(): SelectedInference {
  let spec = (process.env["FORGE_INFERENCE"] || "").trim();
  if (!spec) spec = process.env["FORGE_INFERENCE_URL"] ? "http" : "host";

  const slash = spec.indexOf("/");
  const name = (slash >= 0 ? spec.slice(0, slash) : spec).toLowerCase();
  const pinnedModel = slash >= 0 ? spec.slice(slash + 1) : undefined;

  switch (name) {
    case "host":
      return {
        mode: "host",
        client: new HeuristicInferenceClient(),
        label: "host model via scrape+emit (heuristic fallback for forge_generate)",
        hostBrain: true,
      };
    case "heuristic":
      return { mode: "heuristic", client: new HeuristicInferenceClient(), label: "heuristic (keyless)", hostBrain: false };
    case "http": {
      const url = process.env["FORGE_INFERENCE_URL"];
      if (!url) return heuristicFallback("FORGE_INFERENCE=http but FORGE_INFERENCE_URL unset");
      return { mode: "http", client: new HttpInferenceClient(url, parseHeaders()), label: `custom endpoint (${url})`, hostBrain: false };
    }
    case "claude":
    case "anthropic": {
      if (pinnedModel && !process.env["CLAUDE_MODEL"]) process.env["CLAUDE_MODEL"] = pinnedModel;
      if (!process.env["ANTHROPIC_API_KEY"]) return heuristicFallback("claude selected but ANTHROPIC_API_KEY unset");
      return { mode: "claude", client: new ClaudeInferenceClient(), label: `Anthropic (${process.env["CLAUDE_MODEL"] || "default"})`, hostBrain: false };
    }
    case "gemini":
    case "google": {
      if (pinnedModel && !process.env["GEMINI_MODEL"]) process.env["GEMINI_MODEL"] = pinnedModel;
      if (!process.env["GEMINI_API_KEY"]) return heuristicFallback("gemini selected but GEMINI_API_KEY unset");
      return { mode: "gemini", client: new GeminiInferenceClient(), label: `Gemini (${process.env["GEMINI_MODEL"] || "default"})`, hostBrain: false };
    }
    default: {
      // OpenAI-compatible registry (+ the openai-compatible escape hatch). null => unknown or key missing.
      const resolved = resolveProvider(name, pinnedModel);
      if (!resolved) return heuristicFallback(`'${name}' unknown or its API key not set`);
      return {
        mode: name,
        client: new OpenAICompatibleInferenceClient(resolved.model, { baseURL: resolved.baseURL, apiKey: resolved.apiKey }),
        label: `${resolved.label} (${resolved.model})`,
        hostBrain: false,
      };
    }
  }
}
