/**
 * Lean entry point for EMBEDDING the generator core in a self-contained build (e.g. the standalone
 * `mcp-forge-local` npx package). Deliberately excludes the server-only surface that the main index re-exports
 * - `worker.js` (BullMQ/Redis), `adapters/postgres.js` (drizzle + @mcp/db), enqueue/regenerate/discover - so a
 * bundler can inline this without dragging heavy infra libraries into a single-file CLI artifact.
 *
 * Only the pure pipeline is here: scrape port + inference + codegen + the LLM clients + HTML analysis.
 */
export { generate } from "./generate.js";
export type { GenerateDeps, GenerateOutcome, Scraper, GeneratePersistence } from "./generate.js";

export { generateServer, generateServerSource, packageJson, configSnippet } from "./codegen.js";
export type { CodegenInput } from "./codegen.js";

export { inferTools, validateCandidates, parseCandidates, contentToolFor } from "./inference.js";
export type { InferenceClient, InferenceOutcome } from "./inference.js";

export { analyzeBundleHtml } from "./html-analysis.js";
export * from "./llm-prompts.js";

export { OpenAIInferenceClient } from "./openai-client.js";
export { ClaudeInferenceClient } from "./claude-client.js";
export { GeminiInferenceClient } from "./gemini-client.js";
export { HeuristicInferenceClient } from "./heuristic-inference.js";

export { HttpScraper } from "./adapters/scraper-http.js";
