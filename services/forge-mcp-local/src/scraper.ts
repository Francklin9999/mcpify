import { randomUUID, createHash } from "node:crypto";
import { CaptureBundle, type LegalMode } from "@mcp/types";
import { type Scraper, HttpScraper } from "@mcp/generator/lean";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 mcp-forge";

/** Hang protection + memory bound for the in-process fetch (overridable for unusual pages). */
const FETCH_TIMEOUT_MS = Number(process.env["FORGE_FETCH_TIMEOUT_MS"]) || 20_000;
const FETCH_MAX_BYTES = Number(process.env["FORGE_FETCH_MAX_BYTES"]) || 5_000_000;

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1]?.trim().slice(0, 240) || undefined;
}

/**
 * In-process, dependency-free capture for STATIC / server-rendered pages: one HTTP GET, no browser. Produces a
 * valid CaptureBundle (the keystone contract) the rest of the generator core consumes unchanged. It cannot run
 * client-side JS, so JS-only SPAs yield a thin DOM - for those, set SCRAPER_URL to the full Playwright scraper
 * (a Node Playwright capture is the planned upgrade; see the standalone-MCP product memo).
 */
export class NodeStaticScraper implements Scraper {
  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS}ms` : err instanceof Error ? err.message : String(err);
      throw new Error(`fetch ${url} failed: ${why}`);
    }
    // Fail loudly on a non-2xx instead of silently mining a 404/403/error page as if it were the target.
    if (!res.ok) {
      throw new Error(
        `fetch ${url} returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} - refusing to build from an error page. ` +
          `Use a reachable public URL, or set SCRAPER_URL to a Playwright scraper for JS-rendered / bot-protected sites.`,
      );
    }
    // Reject oversized bodies up front (memory bound); also cap what we keep so downstream hashing/regex stay bounded.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > FETCH_MAX_BYTES) {
      throw new Error(`fetch ${url} body is ${declared} bytes (> ${FETCH_MAX_BYTES}); raise FORGE_FETCH_MAX_BYTES to allow it.`);
    }
    let html = await res.text();
    if (html.length > FETCH_MAX_BYTES) html = html.slice(0, FETCH_MAX_BYTES);
    // Validate our own construction against the keystone contract (parity with HttpScraper, which validates
    // the Python service's wire response) so any future drift fails loudly here rather than deep in inference.
    return CaptureBundle.parse({
      bundleId: randomUUID(),
      source: "scraper",
      url,
      capturedAt: new Date().toISOString(),
      legalMode,
      dom: { html, domHash: createHash("sha256").update(html).digest("hex") },
      network: [],
      meta: { title: extractTitle(html), robotsAllowed: true, renderedWithJs: false },
    });
  }
}

/**
 * Use the full Playwright scraper service when SCRAPER_URL is set (handles JS-rendered sites + network capture);
 * otherwise fall back to the zero-dependency in-process static capture so the server works standalone.
 */
export function chooseScraper(): { scraper: Scraper; kind: "http-service" | "static" } {
  const svc = process.env["SCRAPER_URL"]?.trim();
  if (svc) return { scraper: new HttpScraper(svc), kind: "http-service" };
  return { scraper: new NodeStaticScraper(), kind: "static" };
}
