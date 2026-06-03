import type { CaptureBundle } from "@mcp/types";
import { type InferenceClient, analyzeBundleHtml, TOOL_SYSTEM_PROMPT } from "@mcp/generator/lean";

/**
 * The exact payload the bundled provider clients send the model: the condensed page analysis plus a DOM
 * sample and the observed network. Kept identical to the generator's OpenAI/Claude/Gemini clients so every
 * provider - hosted, local (Ollama/LM Studio), or a custom endpoint - gets the same high-signal input and can
 * reuse the same TOOL_SYSTEM_PROMPT, producing the same tool-candidate JSON the generator's parser unwraps.
 */
export function buildInferencePayload(bundle: CaptureBundle): Record<string, unknown> {
  return {
    url: bundle.url,
    pageAnalysis: analyzeBundleHtml(bundle),
    domSample: bundle.dom.html.slice(0, 8000),
    selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
    network: bundle.network,
  };
}

/**
 * Custom-URL inference - "bring your own logic". POSTs the scraped page (plus the standard system prompt) to a
 * user endpoint and treats the response body as the tool-candidate proposal. The endpoint may return either a
 * bare JSON array, `{ tools: [...] }`, or a JSON string of the same - all of which the generator's
 * parseCandidates() accepts. This is the escape hatch for anyone who wants to run their own model/router/logic
 * (a local script, a LiteLLM/OpenRouter proxy, a homegrown classifier) without us shipping a client for it.
 *   FORGE_INFERENCE_URL      - the endpoint to POST to
 *   FORGE_INFERENCE_HEADERS  - optional JSON object of extra headers (e.g. auth), e.g. {"authorization":"Bearer x"}
 */
export class HttpInferenceClient implements InferenceClient {
  private readonly headers: Record<string, string>;
  constructor(private readonly endpoint: string, extraHeaders?: Record<string, string>) {
    this.headers = { "content-type": "application/json", ...(extraHeaders ?? {}) };
  }

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          systemPrompt: TOOL_SYSTEM_PROMPT,
          url: bundle.url,
          payload: buildInferencePayload(bundle),
          bundle,
        }),
        signal: AbortSignal.timeout(Number(process.env["FORGE_INFERENCE_TIMEOUT_MS"]) || 60_000),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : err instanceof Error ? err.message : String(err);
      throw new Error(`Custom inference endpoint ${this.endpoint} request failed: ${why}.`);
    }
    if (!res.ok) {
      throw new Error(`Custom inference endpoint failed (HTTP ${res.status}) at ${this.endpoint}.`);
    }
    // Accept either a JSON body or a raw text body already in proposal shape; parseCandidates handles both.
    return await res.text();
  }
}
