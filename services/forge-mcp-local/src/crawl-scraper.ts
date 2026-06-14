import { CaptureBundle, LIMITS, type LegalMode } from "@mcp/types";
import { type Scraper } from "@mcp/generator/lean";
import { checkRobots } from "./robots-gate.js";

/**
 * Site-aware capture: given a link, START at the base domain (so the session/cookies warm up and we discover the
 * site's own links), then explore a few same-origin pages AND the complete path we were given, and merge every
 * page's captured XHR/fetch traffic into one bundle — so tool generation sees endpoints from across the site, not
 * just the single page. Wraps whatever inner scraper the backend selected (managed browser, real-Chrome attach, or
 * extension), capturing pages sequentially so the same logged-in session is reused.
 *
 * The page the user pointed at stays the PRIMARY (its DOM is what gets analyzed); the root + explored pages enrich
 * the merged network. Bounded by page count + a wall-clock budget so it never hangs the caller. Env:
 *   FORGE_CRAWL=0              disable (single-page capture, the old behavior)
 *   FORGE_CRAWL_MAX_PAGES      total pages to capture incl. root + given (default 4)
 *   FORGE_CRAWL_BUDGET_MS      stop exploring once this much wall-clock has passed (default 90000)
 *   FORGE_CRAWL_ROBOTS=0       skip the per-explored-page robots.txt check (root + given are already user-intended)
 */

const CRAWL_ON = process.env["FORGE_CRAWL"] !== "0";
const MAX_PAGES = clampInt(process.env["FORGE_CRAWL_MAX_PAGES"], 4, 1, 12);
const BUDGET_MS = Number(process.env["FORGE_CRAWL_BUDGET_MS"]) || 90_000;
const ROBOTS_ON = process.env["FORGE_CRAWL_ROBOTS"] !== "0";

function clampInt(v: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : dflt;
}

// Links we never follow as crawl candidates: assets, and auth/logout endpoints (don't sign the session out!).
const ASSET_EXT = /\.(?:css|js|mjs|cjs|png|jpe?g|gif|svg|webp|avif|ico|bmp|pdf|zip|gz|tar|mp4|webm|mp3|wav|woff2?|ttf|otf|eot|json|xml|rss|txt|csv)(?:$|\?)/i;
const AUTH_PATH = /\/(?:logout|sign[-_]?out|log[-_]?off|login|sign[-_]?in|signin|auth(?:enticate)?|account\/logout|session\/(?:end|destroy))\b/i;

/** Stable key for a URL: origin + path, no trailing slash / query / hash, so dup pages collapse. */
function normalizeKey(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/+$/, "");
    return x.origin + (path || "/");
  } catch {
    return u;
  }
}

/** Same-origin, content-looking links from a page's HTML, in document order, deduped, root + given excluded. */
export function sameOriginLinks(html: string, origin: string, excludeKeys: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>(excludeKeys);
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 60) {
    const href = (m[1] || "").trim();
    if (!href || href.startsWith("#") || /^(?:mailto:|tel:|javascript:|data:|blob:)/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, origin + "/");
    } catch {
      continue;
    }
    if (u.origin !== origin) continue; // same-origin only
    if (ASSET_EXT.test(u.pathname) || AUTH_PATH.test(u.pathname)) continue;
    const key = normalizeKey(u.origin + u.pathname);
    if (key === origin + "/" || seen.has(key)) continue; // skip root + already-known/dups
    seen.add(key);
    out.push(u.origin + u.pathname); // crawl the clean path (no query/hash)
  }
  return out;
}

/** Merge other pages' network into the primary bundle, deduped by (method, templated path), capped, re-validated. */
function mergeNetwork(primary: CaptureBundle, others: CaptureBundle[]): CaptureBundle {
  const seen = new Set(primary.network.map((c) => `${c.method} ${c.urlPattern}`));
  const network = [...primary.network];
  for (const b of others) {
    for (const c of b.network) {
      if (network.length >= LIMITS.maxNetworkCalls) break;
      const k = `${c.method} ${c.urlPattern}`;
      if (seen.has(k)) continue;
      seen.add(k);
      network.push(c);
    }
  }
  return CaptureBundle.parse({ ...primary, network });
}

export class CrawlingScraper implements Scraper {
  constructor(
    private readonly inner: Scraper,
    private readonly robots: (url: string) => Promise<{ allowed: boolean }> = checkRobots,
  ) {}

  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    if (!CRAWL_ON) return this.inner.capture(url, legalMode);

    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return this.inner.capture(url, legalMode); // not parseable -> single capture, let inner report the error
    }
    const rootUrl = origin + "/";
    const givenKey = normalizeKey(url);
    const rootKey = normalizeKey(rootUrl);
    const givenIsRoot = givenKey === rootKey;
    const start = Date.now();
    const captured = new Map<string, CaptureBundle>();

    // 1. Start at the base domain (warms the session + gives us the site's links).
    let rootBundle: CaptureBundle | undefined;
    try {
      rootBundle = await this.inner.capture(rootUrl, legalMode);
      captured.set(rootKey, rootBundle);
    } catch {
      /* root failed; we still try the given path below */
    }

    // 2. Always include the complete path we were given (the primary target).
    let givenBundle: CaptureBundle | undefined;
    if (!givenIsRoot) {
      try {
        givenBundle = await this.inner.capture(url, legalMode);
        captured.set(givenKey, givenBundle);
      } catch {
        /* given failed; fall back to root as primary */
      }
    } else {
      givenBundle = rootBundle;
    }

    // 3. Explore a few same-origin pages discovered from the root, within page + time budget.
    const exclude = new Set<string>([rootKey, givenKey]);
    const candidates = rootBundle ? sameOriginLinks(rootBundle.dom.html, origin, exclude) : [];
    for (const link of candidates) {
      if (captured.size >= MAX_PAGES || Date.now() - start > BUDGET_MS) break;
      const key = normalizeKey(link);
      if (captured.has(key)) continue;
      if (ROBOTS_ON) {
        try {
          if (!(await this.robots(link)).allowed) continue; // respect robots for auto-discovered pages (fail-open)
        } catch {
          /* robots unreachable -> fail open, proceed */
        }
      }
      try {
        captured.set(key, await this.inner.capture(link, legalMode));
      } catch {
        /* skip a page that won't capture */
      }
    }

    // The page the user pointed at is primary (its DOM is analyzed); merge in everyone else's network.
    const primary = givenBundle ?? rootBundle;
    if (!primary) return this.inner.capture(url, legalMode); // crawl captured nothing -> plain single capture (surfaces the real error)
    const others = [...captured.values()].filter((b) => b !== primary);
    return others.length ? mergeNetwork(primary, others) : primary;
  }
}
