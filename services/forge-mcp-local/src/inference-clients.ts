import type { CaptureBundle } from "@mcp/types";
import { type InferenceClient, analyzeBundleHtml, readResponseTextWithLimit, TOOL_SYSTEM_PROMPT } from "@mcp/generator/lean";

const INFERENCE_RESPONSE_MAX_BYTES = Number(process.env["FORGE_INFERENCE_RESPONSE_MAX_BYTES"]) || 1_000_000;

/** The model payload: condensed page analysis + a DOM sample + observed network. Same shape across providers. */
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
 * Custom-URL inference: POST the scraped page to your own endpoint and treat the response as the tool-candidate
 * proposal (array, `{ tools: [...] }`, or a JSON string - all accepted by parseCandidates).
 *   FORGE_INFERENCE_URL      - the endpoint to POST to
 *   FORGE_INFERENCE_HEADERS  - optional JSON object of extra headers (e.g. auth)
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
    return await readResponseTextWithLimit(res, INFERENCE_RESPONSE_MAX_BYTES);
  }
}
