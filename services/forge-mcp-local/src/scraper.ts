import { randomUUID, createHash } from "node:crypto";
import { CaptureBundle, LIMITS, type LegalMode } from "@mcp/types";
import { assertPublicHttpUrl, readResponseTextWithLimit, type Scraper, HttpScraper } from "@mcp/generator/lean";
import { NodePlaywrightScraper, playwrightAvailable } from "./playwright-scraper.js";

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
 * In-process, dependency-free capture for static / server-rendered pages: one HTTP GET, no browser, producing
 * a valid CaptureBundle. JS-only SPAs yield a thin DOM - set SCRAPER_URL to the full Playwright scraper for those.
 */
export class NodeStaticScraper implements Scraper {
  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
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
    if (res.url) await assertPublicHttpUrl(res.url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    // Reject oversized bodies up front (memory bound); also cap what we keep so downstream hashing/regex stay bounded.
    const html = (await readResponseTextWithLimit(res, FETCH_MAX_BYTES)).slice(0, LIMITS.maxHtml);
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

// Anti-bot challenge markers; a static 200 carrying one is a wall, not real content -> escalate to the browser.
const BOT_MARKERS = /are you a human|verify you are human|unusual traffic|captcha|just a moment|checking your browser|enable javascript and cookies|access (?:to this page has been )?denied|attention required/i;
const NEEDS_JS = /\b(?:enable javascript|you need to enable javascript|requires javascript)\b/i;

function visibleTextLength(html: string): number {
  return html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
}

/**
 * Static-first capture that escalates to the in-process stealth browser to render JS and capture XHR/fetch
 * traffic. Discovery mode (default on) escalates whenever a browser is available, so even SSR pages yield their
 * API traffic as tools; a static page that is bot-walled or a thin JS shell always escalates. Set FORGE_BROWSER=0
 * to force the cheap static-only path. Falls back to the static capture if the browser is unavailable or fails.
 */
class EscalatingScraper implements Scraper {
  private readonly staticScraper = new NodeStaticScraper();
  private readonly browser = new NodePlaywrightScraper();

  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    let staticBundle: CaptureBundle | undefined;
    let staticErr: unknown;
    try {
      staticBundle = await this.staticScraper.capture(url, legalMode);
    } catch (err) {
      staticErr = err; // a 4xx/timeout/bot-wall - the browser may still get through, so keep going
    }

    const discovery = process.env["SCRAPER_DISCOVERY_MODE"] !== "0";
    const html = staticBundle?.dom.html ?? "";
    const dynamic = !staticBundle || BOT_MARKERS.test(html.slice(0, 60_000)) || NEEDS_JS.test(html) || visibleTextLength(html) < 600 || /<script/i.test(html);
    const shouldBrowser = discovery || dynamic;

    if (shouldBrowser && (await playwrightAvailable())) {
      try {
        return await this.browser.capture(url, legalMode);
      } catch {
        /* browser failed; fall back to whatever static produced */
      }
    }
    if (staticBundle) return staticBundle;
    throw staticErr ?? new Error(`capture ${url} failed`);
  }
}

/**
 * Pick the capture strategy. SCRAPER_URL (remote Python scraper) wins when set. Otherwise the in-process
 * escalating scraper: static + stealth browser (renders JS, captures traffic) so the standalone handles
 * dynamic / bot-walled sites with no backend. FORGE_BROWSER=0 forces static-only.
 */
export function chooseScraper(): { scraper: Scraper; kind: "http-service" | "browser" | "static" } {
  const svc = process.env["SCRAPER_URL"]?.trim();
  if (svc) return { scraper: new HttpScraper(svc), kind: "http-service" };
  if (process.env["FORGE_BROWSER"] === "0") return { scraper: new NodeStaticScraper(), kind: "static" };
  return { scraper: new EscalatingScraper(), kind: "browser" };
}
