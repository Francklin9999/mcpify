import { CaptureBundle, type LegalMode } from "@mcp/types";
import type { Scraper } from "../generate.js";
import { readResponseTextWithLimit } from "../http-limits.js";

const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 30_000);
const SCRAPER_RESPONSE_MAX_BYTES = Number(process.env.SCRAPER_RESPONSE_MAX_BYTES || 1_500_000);

/**
 * Real `Scraper` adapter: calls the Python scraper service over HTTP (03 Flow A, sync v1) and validates
 * the wire response through the contract - fail-closed, don't trust the wire (the Node<->Python seam).
 */
export class HttpScraper implements Scraper {
  constructor(private readonly baseUrl: string) {}

  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.SCRAPER_TOKEN?.trim();
    if (token) headers["x-scraper-token"] = token;
    const res = await fetch(`${this.baseUrl}/capture`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
      body: JSON.stringify({
        url,
        legalMode,
        acknowledgedFullScrape: legalMode === "full_scrape",
      }),
    });
    const text = await readResponseTextWithLimit(res, SCRAPER_RESPONSE_MAX_BYTES);
    if (!res.ok) throw new Error(`scraper /capture failed: ${res.status} ${text}`);
    const json: unknown = JSON.parse(text);
    // Validate the cross-language response against our zod contract before the generator consumes it.
    return CaptureBundle.parse(json);
  }
}
