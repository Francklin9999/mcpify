/**
 * @mcp/generator — the embedded core pipeline: scrape analysis + tool inference + deterministic codegen.
 *
 * For the self-contained server bundle, prefer the smaller `./lean` entry (what `forge-mcp-local` imports).
 * This entry additionally surfaces the self-heal / versioning helpers used by the test suite.
 */
export * from "./inference.js";
export * from "./incremental.js";
export * from "./codegen.js";
export * from "./generate.js";
export * from "./self-heal.js";
export * from "./version-write.js";
export * from "./http-limits.js";
export * from "./url-safety.js";
export * from "./html-analysis.js";
export * from "./tool-verifier.js";
export * from "./sitemap-discovery.js";
export * from "./api-spec.js";
export * from "./opencli-backend.js";
export * from "./adapters/scraper-http.js";
export { OpenAIInferenceClient, OpenAIHealClient } from "./openai-client.js";
export { ClaudeInferenceClient, ClaudeHealClient } from "./claude-client.js";
export { GeminiInferenceClient, GeminiHealClient } from "./gemini-client.js";
export { HeuristicInferenceClient, HeuristicHealClient } from "./heuristic-inference.js";
export * from "./llm-prompts.js";
