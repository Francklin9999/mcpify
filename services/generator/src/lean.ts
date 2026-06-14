/**
 * Lean entry point for EMBEDDING the generator core in the self-contained `urlmcp` npx package.
 * This is the exact surface `forge-mcp-local` imports, kept minimal so esbuild inlines it into one file.
 *
 * Only the pure pipeline is here: scrape port + inference + codegen + the LLM clients + HTML analysis.
 * The broader `./index` entry additionally exposes the self-heal / versioning helpers used by the tests.
 */
export { generate } from "./generate.js";
export type { GenerateDeps, GenerateOutcome, Scraper, GeneratePersistence } from "./generate.js";

export { generateServer, generateServerSource, packageJson, configSnippet } from "./codegen.js";
export type { CodegenInput } from "./codegen.js";

export { chooseBrowserBackend, deriveDynamicSignals } from "./opencli-backend.js";
export type { BrowserBackend, DynamicSiteSignals } from "./opencli-backend.js";

export { inferTools, validateCandidates, parseCandidates, contentToolFor } from "./inference.js";
export type { InferenceClient, InferenceOutcome } from "./inference.js";

export { analyzeBundleHtml } from "./html-analysis.js";
export { discoverApiSpecTools, openApiToTools, parseOpenApi, graphqlPassthroughTool } from "./api-spec.js";
export { discoverSubPageTools, httpFetchText, parseRobotsTxt } from "./sitemap-discovery.js";
export type { FetchText, RobotsInfo } from "./sitemap-discovery.js";
export { verifyAndAnnotate, verifyAndFilter, httpProbe } from "./tool-verifier.js";
export type { ProbeFn, VerifyReport, ToolVerification } from "./tool-verifier.js";
export * from "./llm-prompts.js";
export { assertPublicHttpUrl } from "./url-safety.js";
export { readResponseTextWithLimit } from "./http-limits.js";

export { OpenAIInferenceClient } from "./openai-client.js";
export { ClaudeInferenceClient } from "./claude-client.js";
export { GeminiInferenceClient } from "./gemini-client.js";
export { HeuristicInferenceClient } from "./heuristic-inference.js";

export { HttpScraper } from "./adapters/scraper-http.js";
