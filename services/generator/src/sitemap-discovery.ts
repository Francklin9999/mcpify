import type { ToolDefinition } from "@mcp/types";

/**
 * Sub-page discovery from a site's OWN declared URL inventory: `/robots.txt` (for `Sitemap:` pointers and
 * `Disallow:` rules) and `/sitemap.xml` (the URL set, possibly a sitemap index). This is a more reliable
 * route to a site's structure than scraping `<a>` tags off one captured page and hoping a detail template
 * repeats >=3 times: a sitemap lists thousands of `/project/{slug}`-style URLs directly, so a single
 * captured DETAIL page (which has no sibling detail links) still yields a parameterized sub-page tool.
 *
 * The expensive parts (parse robots, parse sitemap, cluster URLs into path templates) are PURE and tested
 * offline. Network access is isolated behind an injected `FetchText`, so the orchestrator builds and tests
 * with zero live services - and `Disallow:` rules are honored, so we never template a path the site forbids.
 */

/** Inject the network so the orchestrator stays pure-testable. Returns the body, or null on any failure. */
export type FetchText = (url: string) => Promise<string | null>;

/**
 * Production `FetchText`: a bounded, fail-soft GET (http(s) only, short timeout, response-size cap). Returns
 * null on any non-2xx, timeout, oversize body, or network error - so discovery degrades to fewer tools, never
 * an exception. Use to build a `discoverSubPages` for `GenerateDeps`:
 *   `discoverSubPages: (url) => discoverSubPageTools(url, httpFetchText())`.
 */
export function httpFetchText(opts: { timeoutMs?: number; maxBytes?: number } = {}): FetchText {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  return async (url: string): Promise<string | null> => {
    if (!/^https?:\/\//i.test(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: "text/plain, application/xml, text/xml" } });
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RobotsInfo {
  sitemaps: string[];
  /** Disallowed path prefixes for `User-agent: *` (the rules that apply to everyone). */
  disallow: string[];
}

export interface SubPagePattern {
  /** Tool name, e.g. `get_project_page`. */
  name: string;
  /** Path template with one `{param}` placeholder, e.g. `/project/{slug}`. */
  urlPattern: string;
  rawUrl: string;
  paramName: string;
  /** A representative URL value for the param (for the tool description / examples). */
  example: string;
  /** Distinct values seen at the param position - the evidence this is a real collection. */
  memberCount: number;
}

const ENTITIES_DECODE: Array<[RegExp, string]> = [
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
  [/&#x27;/gi, "'"],
];

function decodeEntities(value: string): string {
  let out = value;
  for (const [re, ch] of ENTITIES_DECODE) out = out.replace(re, ch);
  return out;
}

/**
 * Parse robots.txt: collect every `Sitemap:` directive (they are global, not per-group) and the `Disallow:`
 * prefixes that apply to `User-agent: *`. Lenient and never throws - an unparseable robots.txt yields empty
 * sets (we then fall back to the conventional `/sitemap.xml`).
 */
export function parseRobotsTxt(text: string): RobotsInfo {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let appliesToAll = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sm = line.match(/^sitemap\s*:\s*(\S+)/i);
    if (sm?.[1]) {
      sitemaps.push(sm[1]);
      continue;
    }
    const ua = line.match(/^user-agent\s*:\s*(.+)$/i);
    if (ua) {
      appliesToAll = ua[1]!.trim() === "*";
      continue;
    }
    const dis = line.match(/^disallow\s*:\s*(\S+)/i);
    if (dis?.[1] && appliesToAll) disallow.push(dis[1]);
  }
  return { sitemaps: [...new Set(sitemaps)], disallow: [...new Set(disallow)] };
}

export interface SitemapParse {
  /** "index" => locs are child sitemaps to fetch; "urlset" => locs are page URLs. */
  kind: "index" | "urlset";
  locs: string[];
}

/** Extract `<loc>` values from a sitemap or sitemap index (handles CDATA, entities, namespaces). Never throws. */
export function parseSitemapXml(xml: string): SitemapParse {
  const text = String(xml ?? "");
  const kind: "index" | "urlset" = /<sitemapindex[\s>]/i.test(text) ? "index" : "urlset";
  const locs: string[] = [];
  for (const m of text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)) {
    const loc = decodeEntities((m[1] ?? "").trim());
    if (loc) locs.push(loc);
  }
  return { kind, locs };
}

const ID_SEGMENT = /^\d+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SEGMENT = /^[0-9a-f]{12,}$/i;
const SLUG_ID_SEGMENT = /^[a-z0-9][a-z0-9-]*[-_]\d+$/i;

/** Whether a path segment is conventionally an id (digits / uuid / long hex / slug_123). */
function looksLikeId(segment: string): boolean {
  return ID_SEGMENT.test(segment) || UUID_SEGMENT.test(segment) || HEX_SEGMENT.test(segment) || SLUG_ID_SEGMENT.test(segment);
}

const PLURAL_RULES: Array<[RegExp, string]> = [
  [/ies$/i, "y"],
  [/ses$/i, "s"],
  [/s$/i, ""],
];

function singular(word: string): string {
  for (const [re, repl] of PLURAL_RULES) if (re.test(word)) return word.replace(re, repl);
  return word;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/**
 * Cluster a list of URLs into detail-page templates. For each URL we consider every non-leading segment as a
 * possible `{param}` position; a position is a real collection when MANY distinct values appear there across
 * the corpus (a sitemap of `/project/requests`, `/project/flask`, ... makes `/project/{param}` vary widely
 * while every other position stays fixed). Templates whose param varies across at least `minMembers` URLs
 * are kept, deduped to the strongest one per (entity, depth) family. Pure; bounded by the input size.
 */
export function clusterUrlTemplates(
  urls: string[],
  opts: { origin?: string; minMembers?: number; max?: number; maxTemplates?: number } = {},
): SubPagePattern[] {
  const minMembers = opts.minMembers ?? 8;
  type Group = { entity: string; values: Set<string>; example: string; segCount: number; paramIndex: number; sampleSegs: string[] };
  const groups = new Map<string, Group>();

  for (const raw of urls.slice(0, opts.max ?? 50_000)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (opts.origin && u.origin !== opts.origin) continue;
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2) continue;
    for (let i = 1; i < segs.length; i++) {
      // Only treat a position as a param if it id-like OR there is an entity-ish noun in front of it.
      const entity = segs[i - 1]!;
      if (!/^[a-z]/i.test(entity)) continue;
      const key = `${segs.length}|${i}|${segs.map((s, idx) => (idx === i ? "*" : s)).join("/")}`;
      const group = groups.get(key) ?? { entity, values: new Set<string>(), example: segs[i]!, segCount: segs.length, paramIndex: i, sampleSegs: segs };
      group.values.add(segs[i]!);
      groups.set(key, group);
    }
  }

  const patterns: SubPagePattern[] = [];
  for (const group of groups.values()) {
    if (group.values.size < minMembers) continue;
    // A genuine detail collection: either the entity is a clear noun prefix OR the values look like ids.
    const idShare = [...group.values].slice(0, 50).filter(looksLikeId).length / Math.min(group.values.size, 50);
    if (idShare < 0.5 && !/^[a-z][a-z-]+s?$/i.test(group.entity)) continue;
    const paramName = looksLikeId(group.example) ? "id" : sanitizeName(singular(group.entity)) || "id";
    const segments = group.sampleSegs.map((s, idx) => (idx === group.paramIndex ? `{${paramName}}` : s));
    patterns.push({
      name: `get_${sanitizeName(singular(group.entity))}_page`,
      urlPattern: `/${segments.join("/")}`,
      rawUrl: `${opts.origin ?? ""}/${group.sampleSegs.join("/")}`,
      paramName,
      example: group.example,
      memberCount: group.values.size,
    });
  }

  // Dedup by tool name, keeping the strongest (most members); cap the number of distinct detail-tool families.
  const byName = new Map<string, SubPagePattern>();
  for (const p of patterns.sort((a, b) => b.memberCount - a.memberCount)) {
    if (!byName.has(p.name)) byName.set(p.name, p);
  }
  return [...byName.values()].slice(0, opts.maxTemplates ?? 25);
}

/** Does `path` fall under any `Disallow:` prefix? (Trailing `*` wildcards are treated as prefixes.) */
function isDisallowed(path: string, disallow: string[]): boolean {
  return disallow.some((rule) => {
    const prefix = rule.replace(/\*+$/, "");
    return prefix !== "" && path.startsWith(prefix);
  });
}

function toolFor(pattern: SubPagePattern): ToolDefinition {
  return {
    name: pattern.name,
    description: `Fetch a ${singular(pattern.paramName === "id" ? "page" : pattern.paramName)} detail page by ${pattern.paramName} (from the site's sitemap, e.g. ${pattern.example}) and return readable page text.`,
    inputSchema: { type: "object", properties: { [pattern.paramName]: { type: "string" } }, required: [pattern.paramName] },
    execution: {
      kind: "http",
      request: {
        method: "GET",
        urlPattern: pattern.urlPattern,
        rawUrl: pattern.rawUrl,
        requestHeaders: { accept: "text/html" },
        statusCode: 200,
        contentType: "text/html",
      },
      paramMapping: { [pattern.paramName]: { in: "path", key: pattern.paramName } },
    },
    confidence: 0.6,
  };
}

export interface SubPageDiscoveryOptions {
  /** Max child sitemaps to fetch from an index (each is a network call). */
  maxSitemaps?: number;
  /** Max URLs to feed the clusterer. */
  maxUrls?: number;
  /** Min distinct param values for a template to count as a real collection. */
  minMembers?: number;
  /** Max distinct detail-tool families to emit (the per-link "how many tools" cap). */
  maxTemplates?: number;
}

/**
 * Discover sub-page tools for a site from robots.txt + sitemap.xml. Bounded and fail-soft: any fetch/parse
 * failure simply yields fewer (or zero) tools, never an error. Honors `Disallow:` so forbidden paths are
 * never templated into tools.
 */
export async function discoverSubPageTools(
  pageUrl: string,
  fetchText: FetchText,
  opts: SubPageDiscoveryOptions = {},
): Promise<ToolDefinition[]> {
  const maxSitemaps = opts.maxSitemaps ?? 3;
  const maxUrls = opts.maxUrls ?? 20_000;
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }

  const robotsText = (await fetchText(`${origin}/robots.txt`)) ?? "";
  const robots = parseRobotsTxt(robotsText);
  const sitemapUrls = [...new Set([...robots.sitemaps, `${origin}/sitemap.xml`])].slice(0, maxSitemaps + 1);

  const pageUrls: string[] = [];
  let fetchedSitemaps = 0;
  for (const sitemapUrl of sitemapUrls) {
    if (fetchedSitemaps >= maxSitemaps || pageUrls.length >= maxUrls) break;
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;
    fetchedSitemaps++;
    const parsed = parseSitemapXml(xml);
    if (parsed.kind === "index") {
      // One level of index expansion: fetch a few child sitemaps for their page URLs.
      for (const child of parsed.locs.slice(0, maxSitemaps - fetchedSitemaps + 1)) {
        if (pageUrls.length >= maxUrls) break;
        const childXml = await fetchText(child);
        fetchedSitemaps++;
        if (childXml) pageUrls.push(...parseSitemapXml(childXml).locs);
      }
    } else {
      pageUrls.push(...parsed.locs);
    }
  }

  const allowed = pageUrls.filter((u) => {
    try {
      return !isDisallowed(new URL(u).pathname, robots.disallow);
    } catch {
      return false;
    }
  });

  return clusterUrlTemplates(allowed, { origin, minMembers: opts.minMembers, max: maxUrls, maxTemplates: opts.maxTemplates }).map(toolFor);
}
