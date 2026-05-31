import { CaptureBundle, type LegalMode } from "@mcp/types";
import type { Scraper } from "../generate.js";

/**
 * Real `Scraper` adapter: calls the Python scraper service over HTTP (03 Flow A, sync v1) and validates
 * the wire response through the contract - fail-closed, don't trust the wire (the Node<->Python seam).
 */
export class HttpScraper implements Scraper {
  constructor(private readonly baseUrl: string) {}

  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    const res = await fetch(`${this.baseUrl}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        legalMode,
        acknowledgedFullScrape: legalMode === "full_scrape",
      }),
    });
    if (!res.ok) throw new Error(`scraper /capture failed: ${res.status} ${await res.text()}`);
    const json: unknown = await res.json();
    // Validate the cross-language response against our zod contract before the generator consumes it.
    return CaptureBundle.parse(json);
  }
}
