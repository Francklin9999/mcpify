/**
 * Provider registry - the canonical multi-provider abstraction (LiteLLM / OpenRouter / Bifrost pattern).
 *
 * The key realization (verified against the 2026 gateway ecosystem): almost every LLM endpoint - OpenAI,
 * Groq, Together, OpenRouter, DeepSeek, Mistral, Fireworks, xAI, AND every local server (Ollama, LM Studio,
 * vLLM) - speaks the SAME OpenAI `/v1/chat/completions` schema. So we DON'T ship a bespoke client per
 * provider. We ship ONE OpenAI-compatible client (openai-compatible-client.ts) and a registry of base URLs.
 * Adding a provider is a data entry here, not new code. Anything not listed still works via the
 * `openai-compatible` escape hatch (FORGE_OPENAI_BASE_URL) - so the abstraction never blocks a new provider.
 *
 * Native (non-OpenAI-schema) providers - Anthropic, Gemini - are handled separately in select-inference.ts
 * by reusing the generator's existing native clients (both also expose OpenAI-compat endpoints, but the
 * native clients are already built and tested, so we keep them).
 *
 * Keys use each provider's CONVENTIONAL env var (OPENAI_API_KEY, GROQ_API_KEY, ...) so a user's existing
 * environment Just Works - we don't invent FORGE_-prefixed key names.
 */

export interface ProviderSpec {
  /** OpenAI-compatible base URL. Omitted for vanilla OpenAI (the SDK default). */
  baseURL?: string;
  /** Optional env var that overrides `baseURL` (for self-hosted endpoints on a non-default host/port). */
  baseUrlEnv?: string;
  /** Conventional env var holding the API key. */
  apiKeyEnv: string;
  /** Used when the user doesn't pin one via the provider/model form, FORGE_MODEL, or `modelEnv`. */
  defaultModel: string;
  /** Optional provider-conventional env var that selects the model (e.g. OLLAMA_MODEL). */
  modelEnv?: string;
  /** Local servers need no real key; we send a harmless placeholder so the SDK is happy. */
  keyOptional?: boolean;
  placeholderKey?: string;
  /** Human label for diagnostics. */
  label: string;
}

/** OpenAI-compatible providers. Add a row to support a new one - no code change needed. */
export const OPENAI_COMPATIBLE: Record<string, ProviderSpec> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", defaultModel: "gpt-4o-mini", label: "OpenAI" },
  groq: { baseURL: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", label: "Groq" },
  together: { baseURL: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Together AI" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "openai/gpt-4o-mini", label: "OpenRouter" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", label: "DeepSeek" },
  mistral: { baseURL: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest", label: "Mistral" },
  fireworks: { baseURL: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Fireworks" },
  xai: { baseURL: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "grok-2-latest", label: "xAI (Grok)" },
  // Local / self-hosted - no key required. Base URL + model overridable via the conventional env vars.
  ollama: { baseURL: "http://localhost:11434/v1", baseUrlEnv: "OLLAMA_URL", apiKeyEnv: "OLLAMA_API_KEY", modelEnv: "OLLAMA_MODEL", defaultModel: "llama3.1", keyOptional: true, placeholderKey: "ollama", label: "Ollama (local)" },
  lmstudio: { baseURL: "http://localhost:1234/v1", baseUrlEnv: "LMSTUDIO_URL", apiKeyEnv: "LMSTUDIO_API_KEY", modelEnv: "LMSTUDIO_MODEL", defaultModel: "local-model", keyOptional: true, placeholderKey: "lm-studio", label: "LM Studio (local)" },
  vllm: { baseURL: "http://localhost:8000/v1", baseUrlEnv: "VLLM_BASE_URL", apiKeyEnv: "VLLM_API_KEY", modelEnv: "VLLM_MODEL", defaultModel: "local-model", keyOptional: true, placeholderKey: "vllm", label: "vLLM (local)" },
};

export interface ResolvedProvider {
  baseURL?: string;
  apiKey: string;
  model: string;
  label: string;
}

/**
 * Resolve an OpenAI-compatible provider name (+ optional pinned model) into a ready-to-use config.
 * `model` precedence: pinned arg (the `provider/model` form) > FORGE_MODEL > the provider's conventional
 * `modelEnv` (e.g. OLLAMA_MODEL) > the provider's default.
 * `baseURL` precedence: the provider's `baseUrlEnv` (e.g. OLLAMA_URL) > the provider's default.
 * Returns null when a hosted provider is selected but its key env is missing (so the caller can fall back).
 */
export function resolveProvider(name: string, pinnedModel?: string): ResolvedProvider | null {
  // Escape hatch: any OpenAI-compatible endpoint not in the table.
  if (name === "openai-compatible" || name === "custom-openai") {
    const baseURL = process.env["FORGE_OPENAI_BASE_URL"];
    if (!baseURL) throw new Error("FORGE_INFERENCE=openai-compatible requires FORGE_OPENAI_BASE_URL.");
    return {
      baseURL,
      apiKey: process.env["FORGE_API_KEY"] || process.env["OPENAI_API_KEY"] || "not-needed",
      model: pinnedModel || process.env["FORGE_MODEL"] || "default",
      label: `OpenAI-compatible (${baseURL})`,
    };
  }

  const spec = OPENAI_COMPATIBLE[name];
  if (!spec) return null;

  const key = process.env[spec.apiKeyEnv];
  if (!key && !spec.keyOptional) return null; // hosted provider with no key -> let caller fall back

  const baseURL = (spec.baseUrlEnv ? process.env[spec.baseUrlEnv]?.trim() : undefined) || spec.baseURL;
  const model =
    pinnedModel ||
    process.env["FORGE_MODEL"] ||
    (spec.modelEnv ? process.env[spec.modelEnv]?.trim() : undefined) ||
    spec.defaultModel;

  return {
    baseURL,
    apiKey: key || spec.placeholderKey || "not-needed",
    model,
    label: spec.label,
  };
}
