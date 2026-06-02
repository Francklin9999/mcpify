import type { AppStateSummary, CaptureBundle } from "@mcp/types";
import { resolveBaseHref, stripNonRenderedMarkup } from "./html-sanitize.js";

export interface HtmlField {
  name: string;
  type: string;
  placeholder?: string;
  required: boolean;
}

export interface HtmlFormSummary {
  method: "GET" | "POST";
  action: string;
  purpose: "search" | "auth" | "form";
  fields: HtmlField[];
}

export interface HtmlLinkSummary {
  href: string;
  text: string;
}

export interface DetailLinkPattern {
  name: string;
  urlPattern: string;
  rawUrl: string;
  paramName: string;
  description: string;
  confidence: number;
}

export interface QueryLinkPattern {
  name: string;
  method: "GET";
  urlPattern: string;
  rawUrl: string;
  description: string;
  params: { name: string; required: boolean }[];
  confidence: number;
}

export interface SearchActionPattern {
  name: "search";
  method: "GET";
  urlPattern: string;
  rawUrl: string;
  queryParam: string;
  description: string;
  confidence: number;
}

export interface AppStateHint {
  source: string;
  keys: string[];
  types: string[];
}

export interface PageAnalysis {
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  textSample: string;
  headings: string[];
  jsonLdTypes: string[];
  appStateHints: AppStateHint[];
  likelyPageKinds: string[];
  forms: HtmlFormSummary[];
  links: HtmlLinkSummary[];
  buttons: string[];
  detailLinkPatterns: DetailLinkPattern[];
  queryLinkPatterns: QueryLinkPattern[];
  searchActions: SearchActionPattern[];
}

const SEARCH_FIELDS = new Set(["q", "query", "search", "s", "keyword", "keywords", "term", "searchterm", "find_desc", "k", "_nkw", "search_term_string", "text"]);
const PRODUCT_SEGMENTS = new Set(["dp", "product", "products", "itm", "sku"]);
const ENTITY_SEGMENTS: Record<string, { name: string; paramName: string; description: string }> = {
  package: {
    name: "get_package_page",
    paramName: "package",
    description: "Fetch a package detail page by package name and return readable page text.",
  },
  author: {
    name: "get_author_page",
    paramName: "author",
    description: "Fetch an author detail page by author id and return readable page text.",
  },
  gems: {
    name: "get_gem_page",
    paramName: "gem",
    description: "Fetch a RubyGems detail page by gem name and return readable page text.",
  },
};
const PAGE_FIELD_RE = /^(?:page|p|page_num|pagenum|page_number|pagenumber)$/i;
const TRAVEL_TEXT_RE = /\b(?:flights?|airport|airfare|depart(?:ure|ing)?|roundtrip|round trip|one[- ]way|travell?ers?|adults?|hotels?|stays?|car rental|cars? hire)\b/;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function cleanText(value: string, max = 240): string {
  const text = decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function absoluteUrl(raw: string, base: string): string | null {
  if (!raw || /^(javascript|mailto|tel):/i.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function pathFor(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function parseTitle(html: string): string | undefined {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? cleanText(title, 160) : undefined;
}

function parseMeta(html: string, name: string): string | undefined {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attrs(match[1] ?? "");
    if ((a.name || a.property || "").toLowerCase() === name.toLowerCase() && a.content) return cleanText(a.content, 500);
  }
  return undefined;
}

function parseCanonical(html: string, baseUrl: string): string | undefined {
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrs(match[1] ?? "");
    if ((a.rel || "").toLowerCase() === "canonical" && a.href) return absoluteUrl(a.href, baseUrl) ?? undefined;
  }
  return undefined;
}

function collectJsonLdTypes(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const type = obj["@type"];
  if (typeof type === "string") out.add(type);
  else if (Array.isArray(type)) for (const item of type) if (typeof item === "string") out.add(item);
  for (const nested of Object.values(obj)) collectJsonLdTypes(nested, out);
}

function collectSearchActions(value: unknown, out: SearchActionPattern[], baseUrl: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSearchActions(item, out, baseUrl);
    return;
  }
  const obj = value as Record<string, unknown>;
  const type = obj["@type"];
  const isSearchAction = type === "SearchAction" || (Array.isArray(type) && type.includes("SearchAction"));
  if (isSearchAction) {
    const targetRaw =
      typeof obj.target === "string"
        ? obj.target
        : obj.target && typeof obj.target === "object" && typeof (obj.target as Record<string, unknown>).urlTemplate === "string"
          ? String((obj.target as Record<string, unknown>).urlTemplate)
          : "";
    const queryInput = typeof obj["query-input"] === "string" ? obj["query-input"] : "";
    const target = absoluteUrl(targetRaw.replace(/\{[^}]+\}/g, "placeholder"), baseUrl);
    const paramMatch = targetRaw.match(/[?&]([^=&{}]+)=\{[^}]+\}/);
    const queryInputMatch = queryInput.match(/(?:required\s+)?name=([a-zA-Z0-9_-]+)/i);
    const queryParam = paramMatch?.[1] ?? queryInputMatch?.[1];
    if (target && queryParam) {
      out.push({
        name: "search",
        method: "GET",
        urlPattern: pathFor(target),
        rawUrl: targetRaw.includes("{") ? target.replace("placeholder", "") : target,
        queryParam,
        description: `Search the site using its structured SearchAction (${queryParam}).`,
        confidence: 0.66,
      });
    }
  }
  for (const nested of Object.values(obj)) collectSearchActions(nested, out, baseUrl);
}

function parseJsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const a = attrs(match[1] ?? "");
    if (!/ld\+json/i.test(a.type || "")) continue;
    try {
      collectJsonLdTypes(JSON.parse(match[2] ?? ""), types);
    } catch {
      /* Ignore malformed JSON-LD; HTML analysis must never block generation. */
    }
  }
  return [...types].slice(0, 40);
}

function parseSearchActions(html: string, pageUrl: string): SearchActionPattern[] {
  const actions: SearchActionPattern[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const a = attrs(match[1] ?? "");
    if (!/ld\+json/i.test(a.type || "")) continue;
    try {
      collectSearchActions(JSON.parse(match[2] ?? ""), actions, pageUrl);
    } catch {
      /* Ignore malformed JSON-LD. */
    }
  }
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.urlPattern}?${action.queryParam}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function parseForms(html: string, pageUrl: string): HtmlFormSummary[] {
  const forms: HtmlFormSummary[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    if (forms.length >= 12) break;
    const formAttrs = attrs(match[1] ?? "");
    const inner = match[2] ?? "";
    const method = /post/i.test(formAttrs.method || "") ? "POST" : "GET";
    const action = absoluteUrl(formAttrs.action || pageUrl, pageUrl);
    if (!action) continue;

    const fields: HtmlField[] = [];
    for (const field of inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const tag = field[1]!.toLowerCase();
      const a = attrs(field[2] ?? "");
      const name = a.name;
      if (!name) continue;
      const type = (tag === "input" ? a.type || "text" : tag).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file"].includes(type)) continue;
      fields.push({ name, type, placeholder: a.placeholder || undefined, required: "required" in a || SEARCH_FIELDS.has(name.toLowerCase()) });
      if (fields.length >= 16) break;
    }
    const hasPassword = /type\s*=\s*["']?password/i.test(inner);
    const purpose = hasPassword ? "auth" : fields.some((field) => SEARCH_FIELDS.has(field.name.toLowerCase()) || field.type === "search") ? "search" : "form";
    forms.push({ method, action, purpose, fields });
  }
  return forms;
}

function parseLinks(html: string, pageUrl: string): HtmlLinkSummary[] {
  const links: HtmlLinkSummary[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 160) break;
    const a = attrs(match[1] ?? "");
    const href = absoluteUrl(a.href || "", pageUrl);
    if (!href || seen.has(href)) continue;
    const text = cleanText(match[2] ?? "", 180);
    if (!text && !/\/(dp|products?|items?|p)\//i.test(pathFor(href))) continue;
    seen.add(href);
    links.push({ href, text });
  }
  return links;
}

function parseButtons(html: string): string[] {
  const buttons: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>|<input\b([^>]*\btype\s*=\s*["']?(?:submit|button)["']?[^>]*)>/gi)) {
    if (buttons.length >= 80) break;
    const text = match[1] ? cleanText(match[1], 120) : cleanText(attrs(match[2] ?? "").value || "", 120);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    buttons.push(text);
  }
  return buttons;
}

function textSample(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return cleanText(text, 8000);
}

function appStateHints(bundle: CaptureBundle): AppStateHint[] {
  return (bundle.page?.appState ?? [])
    .map((entry: AppStateSummary) => ({
      source: entry.source,
      keys: entry.keys ?? [],
      types: entry.types ?? [],
    }))
    .slice(0, 12);
}

function productPatternFor(link: HtmlLinkSummary): DetailLinkPattern | null {
  const url = new URL(link.href);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  for (let index = 0; index < parts.length - 1; index++) {
    const segment = parts[index]!.toLowerCase();
    if (!PRODUCT_SEGMENTS.has(segment)) continue;
    const paramName = segment === "dp" ? "asin" : "id";
    const patternParts = [...parts];
    patternParts[index + 1] = `{${paramName}}`;
    const name = paramName === "asin" || /product/i.test(segment) ? "get_product_page" : "get_item_page";
    return {
      name,
      urlPattern: `/${patternParts.join("/")}`,
      rawUrl: link.href,
      paramName,
      description:
        paramName === "asin"
          ? "Fetch a product detail page by ASIN and return readable product page text."
          : "Fetch a product or item detail page by id and return readable page text.",
      confidence: 0.58,
    };
  }
  return null;
}

function slugIdPatternFor(link: HtmlLinkSummary): DetailLinkPattern | null {
  const url = new URL(link.href);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === "category")) return null;
  const index = parts.findIndex((part) => /^[a-z0-9][a-z0-9-]+_\d+$/i.test(part));
  if (index < 0) return null;
  const patternParts = [...parts];
  patternParts[index] = "{id}";
  return {
    name: "get_product_page",
    urlPattern: `/${patternParts.join("/")}`,
    rawUrl: link.href,
    paramName: "id",
    description: "Fetch a repeated catalog detail page by id and return readable page text.",
    confidence: 0.55,
  };
}

function entityPatternFor(link: HtmlLinkSummary): DetailLinkPattern | null {
  const url = new URL(link.href);
  const parts = url.pathname.split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 1; index++) {
    const segment = parts[index]!.toLowerCase();
    const entity = ENTITY_SEGMENTS[segment];
    if (!entity) continue;
    const patternParts = [...parts];
    if (segment === "package") {
      patternParts.splice(index + 1, patternParts.length - index - 1, `{${entity.paramName}}`);
    } else {
      patternParts[index + 1] = `{${entity.paramName}}`;
    }
    return {
      name: entity.name,
      urlPattern: `/${patternParts.join("/")}`,
      rawUrl: link.href,
      paramName: entity.paramName,
      description: entity.description,
      confidence: 0.56,
    };
  }
  return null;
}

function detailPatterns(links: HtmlLinkSummary[], pageUrl: string): DetailLinkPattern[] {
  const grouped = new Map<string, DetailLinkPattern & { count: number }>();
  const pageOrigin = origin(pageUrl);
  for (const link of links) {
    if (pageOrigin && origin(link.href) !== pageOrigin) continue;
    const pattern = productPatternFor(link) ?? slugIdPatternFor(link) ?? entityPatternFor(link);
    if (!pattern) continue;
    const key = `${origin(pattern.rawUrl)} ${pattern.urlPattern} ${pattern.paramName}`;
    const current = grouped.get(key);
    if (current) current.count++;
    else grouped.set(key, { ...pattern, count: 1 });
  }
  return [...grouped.values()]
    .filter((pattern) => pattern.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(({ count: _count, ...pattern }) => pattern);
}

function queryLinkPatterns(links: HtmlLinkSummary[], pageUrl: string): QueryLinkPattern[] {
  const grouped = new Map<
    string,
    {
      path: string;
      rawUrl: string;
      keys: Map<string, Set<string>>;
      count: number;
      hasPage: boolean;
      hasSearch: boolean;
    }
  >();
  const pageOrigin = origin(pageUrl);
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (pageOrigin && url.origin !== pageOrigin) continue;
    if (![...url.searchParams.keys()].length) continue;
    const path = url.pathname || "/";
    const key = `${url.origin}${path}`;
    const current = grouped.get(key) ?? {
      path,
      rawUrl: `${url.origin}${path}`,
      keys: new Map<string, Set<string>>(),
      count: 0,
      hasPage: false,
      hasSearch: false,
    };
    current.count++;
    for (const param of new Set(url.searchParams.keys())) {
      const values = current.keys.get(param) ?? new Set<string>();
      const rawValue = url.searchParams.get(param);
      if (rawValue) values.add(rawValue);
      current.keys.set(param, values);
      if (PAGE_FIELD_RE.test(param)) current.hasPage = true;
      if (SEARCH_FIELDS.has(param.toLowerCase())) current.hasSearch = true;
    }
    grouped.set(key, current);
  }

  const patterns: QueryLinkPattern[] = [];
  for (const group of grouped.values()) {
    const varyingKeys = [...group.keys.entries()].filter(([, values]) => values.size >= 2).map(([name]) => name);
    if (varyingKeys.length === 0) continue;
    const params = [...group.keys.keys()]
      .filter((name) => varyingKeys.includes(name) || SEARCH_FIELDS.has(name.toLowerCase()) || PAGE_FIELD_RE.test(name))
      .slice(0, 6)
      .map((name) => ({ name, required: SEARCH_FIELDS.has(name.toLowerCase()) }));
    if (params.length === 0) continue;
    const name = group.hasSearch ? "search" : group.hasPage ? "paginate_results" : "browse_listing";
    const description = group.hasSearch
      ? `Search or refine results on ${group.rawUrl}.`
      : group.hasPage
        ? `Paginate or filter listing results on ${group.rawUrl}.`
        : `Browse listing results on ${group.rawUrl} with query parameters.`;
    patterns.push({
      name,
      method: "GET",
      urlPattern: group.path,
      rawUrl: group.rawUrl,
      description,
      params,
      confidence: group.hasSearch ? 0.62 : group.hasPage ? 0.56 : 0.54,
    });
  }
  return patterns.slice(0, 8);
}

function currentPageQueryPatterns(bundle: CaptureBundle): { queryPatterns: QueryLinkPattern[]; searchActions: SearchActionPattern[] } {
  let url: URL;
  try {
    url = new URL(bundle.url);
  } catch {
    return { queryPatterns: [], searchActions: [] };
  }
  const keys = [...new Set(url.searchParams.keys())];
  if (keys.length === 0) return { queryPatterns: [], searchActions: [] };

  const searchKey = keys.find((key) => SEARCH_FIELDS.has(key.toLowerCase()));
  const pageKey = keys.find((key) => PAGE_FIELD_RE.test(key));
  const filterKeys = keys.filter((key) => key !== searchKey && key !== pageKey).slice(0, 6);

  const queryPatterns: QueryLinkPattern[] = [];
  const searchActions: SearchActionPattern[] = [];

  if (searchKey) {
    searchActions.push({
      name: "search",
      method: "GET",
      urlPattern: url.pathname || "/",
      rawUrl: `${url.origin}${url.pathname || "/"}`,
      queryParam: searchKey,
      description: `Search the site using the current page's query pattern (${searchKey}).`,
      confidence: 0.61,
    });
  }

  if (pageKey || filterKeys.length > 0) {
    const params = [
      ...(searchKey ? [{ name: searchKey, required: true }] : []),
      ...(pageKey ? [{ name: pageKey, required: false }] : []),
      ...filterKeys.map((name) => ({ name, required: false })),
    ];
    queryPatterns.push({
      name: searchKey ? "search" : pageKey ? "paginate_results" : "browse_listing",
      method: "GET",
      urlPattern: url.pathname || "/",
      rawUrl: `${url.origin}${url.pathname || "/"}`,
      description: searchKey
        ? `Search or refine results on ${url.origin}${url.pathname || "/"}.`
        : pageKey
          ? `Paginate or filter listing results on ${url.origin}${url.pathname || "/"}.`
          : `Browse listing results on ${url.origin}${url.pathname || "/"} with query parameters.`,
      params,
      confidence: searchKey ? 0.6 : pageKey ? 0.55 : 0.53,
    });
  }

  return { queryPatterns, searchActions };
}

function likelyKinds(bundle: CaptureBundle, forms: HtmlFormSummary[], links: HtmlLinkSummary[], jsonLdTypes: string[], text: string): string[] {
  const kinds = new Set<string>();
  const url = bundle.url.toLowerCase();
  const host = (() => {
    try {
      return new URL(bundle.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const hay = `${url} ${bundle.meta.title ?? ""} ${text.slice(0, 2000)}`.toLowerCase();
  const pageHay = JSON.stringify(bundle.page?.appState ?? []).toLowerCase();
  const commerce =
    jsonLdTypes.some((type) => /product|offer/i.test(type)) ||
    /\/dp\/|\/products?\/|\/itm\//i.test(url) ||
    (!/news\.ycombinator\.com/i.test(url) && /add to cart|add to basket|buy now|availability|in stock|out of stock/.test(hay));
  const travel =
    !commerce &&
    (/(^|\.)(?:skyscanner|booking|expedia|kayak|airbnb|hotels|tripadvisor)\./.test(host) ||
      TRAVEL_TEXT_RE.test(hay) ||
      jsonLdTypes.some((type) => /flight|trip|travel|hotel|lodgingbusiness|airline/i.test(type)));
  if (forms.some((form) => form.purpose === "search")) kinds.add("searchable");
  if (travel) kinds.add("travel");
  if (jsonLdTypes.some((type) => /product/i.test(type)) || /\/dp\/|\/products?\//i.test(url)) kinds.add("product_detail");
  if (!travel && links.filter((link) => productPatternFor(link)).length >= 2) kinds.add("product_listing");
  if (!travel && /product|sku|asin|offer|price/.test(pageHay)) kinds.add("product_detail");
  if (!travel && /results|searchterm|search_term|string|items|edges|products/.test(pageHay)) kinds.add("product_listing");
  if (/cart|basket|checkout/.test(hay)) kinds.add("commerce");
  if (!travel && commerce) kinds.add("commerce");
  return [...kinds];
}

export function analyzeBundleHtml(bundle: CaptureBundle): PageAnalysis {
  const html = bundle.dom.html || "";
  // Mine structure (links/forms/buttons) only from markup a browser renders as live DOM, and resolve
  // relative URLs against the document's <base href>. JSON-LD, text, title, and meta below keep reading
  // the raw html (JSON-LD lives inside <script>, which the sanitized markup intentionally drops).
  const markup = stripNonRenderedMarkup(html);
  // Resolve <base href> from the sanitized markup (not raw html) so a <base> mentioned inside a comment or
  // script string can't shadow the real one - the same reason link/form mining runs on `markup`.
  const linkBase = resolveBaseHref(markup, bundle.url);
  const forms = parseForms(markup, linkBase);
  const links = parseLinks(markup, linkBase);
  const buttons = parseButtons(markup);
  const jsonLdTypes = parseJsonLdTypes(html);
  const searchActions = parseSearchActions(html, bundle.url);
  const currentPagePatterns = currentPageQueryPatterns(bundle);
  const sample = cleanText(`${bundle.page?.visibleText ?? ""}\n${textSample(html)}`, 8000);
  return {
    title: bundle.meta.title ?? parseTitle(html),
    metaDescription: parseMeta(html, "description") ?? parseMeta(html, "og:description"),
    canonicalUrl: parseCanonical(html, bundle.url),
    textSample: sample,
    headings: bundle.page?.headings ?? [],
    jsonLdTypes,
    appStateHints: appStateHints(bundle),
    likelyPageKinds: likelyKinds(bundle, forms, links, jsonLdTypes, sample),
    forms,
    links: links.slice(0, 80),
    buttons,
    // Filter link-derived patterns against the SAME base the links resolved against (linkBase), so a
    // <base href> pointing at a sibling host (www vs apex, or a CDN) keeps its detail/query tools instead
    // of dropping them as "cross-origin". With no <base> (or a same-origin one) linkBase === bundle.url.
    detailLinkPatterns: detailPatterns(links, linkBase),
    queryLinkPatterns: [...currentPagePatterns.queryPatterns, ...queryLinkPatterns(links, linkBase)],
    searchActions: [...currentPagePatterns.searchActions, ...searchActions],
  };
}
