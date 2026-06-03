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
 * Which brain does the server-side `forge_generate` tool use? ONE knob: FORGE_INFERENCE.
 *
 * Accepts a provider name OR the LiteLLM-style `provider/model` form (e.g. `groq/llama-3.3-70b-versatile`):
 *
 *   host (default)   - NO server-side brain. Use forge_scrape + forge_emit_server and let the CALLING model
 *                      (Claude Code / Codex / ...) infer the tools - zero key, exactly like other MCP servers.
 *                      forge_generate still works via the keyless heuristic fallback.
 *   heuristic        - keyless rule-based inference (no LLM, no key, no network).
 *   openai|groq|together|openrouter|deepseek|mistral|fireworks|xai
 *                    - hosted OpenAI-compatible providers (need that provider's conventional API key env).
 *   ollama|lmstudio|vllm
 *                    - LOCAL OpenAI-compatible servers (no key; just run the server).
 *   openai-compatible - ANY other OpenAI-compatible endpoint via FORGE_OPENAI_BASE_URL (+ FORGE_API_KEY).
 *   claude|gemini    - native Anthropic / Google clients (ANTHROPIC_API_KEY / GEMINI_API_KEY).
 *   http             - your own endpoint (FORGE_INFERENCE_URL) - bring your own logic.
 *
 * Anything requested but missing its key falls back to the keyless heuristic (never crashes).
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
    console.error("[mcp-forge] FORGE_INFERENCE_HEADERS must be a JSON object; ignoring it.");
    return undefined;
  } catch {
    console.error("[mcp-forge] FORGE_INFERENCE_HEADERS is not valid JSON; ignoring it.");
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
