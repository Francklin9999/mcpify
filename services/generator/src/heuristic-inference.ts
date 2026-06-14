import type { CaptureBundle, PageAction, PageField, PageForm } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml, type HtmlFormSummary, type PageAnalysis } from "./html-analysis.js";

/**
 * No-LLM fallback inference. Builds REAL, runnable tools from a CaptureBundle without any model key:
 *   - content tool      : fetch the page as readable text (floor; every site gets this)
 *   - network tools     : one per observed XHR/fetch call, with path + query params
 *   - form tools        : one per HTML <form> (search boxes etc.) with its fields as params
 * Lower confidence than a real model, but genuinely useful and free. Each producer is a pure function and
 * never throws (a parse failure yields no tools, never a crashed worker).
 */

// Query keys that are tracking/session noise, not real inputs - extracted tools shouldn't surface them.
const TRACKING = /^(utm_|pd_rd_|pf_rd_|_$|fbclid$|gclid$|ref_?$|mc_|igshid$|s_kwcid$)/i;
const isTracking = (k: string) => TRACKING.test(k) || k === "_";
const NOISY_HOST =
  /(google-analytics|googlesyndication|googletagmanager|googleadservices|doubleclick|2mdn|newrelic|nr-data|segment|sentry|hotjar|amplitude|optimizely|facebook|connect\.facebook|bing|adsrvr|demdex|datadog|scorecardresearch|moatads|doubleverify|adsafeprotected|criteo|taboola|outbrain|quantserve|chartbeat|parsely|fwmrm|litix|brightline|onetrust|cookielaw|branch\.io|mixpanel|fullstory|mouseflow|clarity\.ms|snowplow|tealium|krxd|rubiconproject|pubmatic|openx|casalemedia|smartadserver|adnxs|3lift|bidswitch|media\.max\.com|discomax|imrworldwide|nielsen|comscore)/i;
const NOISY_PATH = /(?:^|\/)(collect|collector|analytics|tracking|telemetry|metrics|events?|pagead|conversion|viewthroughconversion|newrelic|nrjs|jserrors|experimentchokepoint|ccm|rmkt|tallyman|loginwebevent|funnel|beacon|pixel|impression|gtm|gtag|stats|logging|ping|rum|vitals|consent|cmp|gdpr|playbackinfo|heartbeat)(?:\/|$)|\/g\/collect\b|\/sid\.json\b/i;
// Static assets + media/streaming segments (HLS/DASH chunks): not API tools.
const STATIC_ASSET =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|webmanifest|webp|avif|bmp|mp4|m4s|m4a|ts|mp3|wav|webm|mov|avi|mkv|flv|aac|ogg|oga|ogv|flac|m3u8|mpd|vtt|srt|pdf|zip|gz)$/i;
// Media/font/image/beacon content-types: assets, not callable JSON/text APIs.
const NOISY_CTYPE = /(?:^|[^a-z])(video|audio|image|font)\/|beacon|analytics|telemetry|tracking|octet-stream|event-stream/i;
const CHALLENGE_FORM = /captcha|nocaptcha|recaptcha|challenge|human.?verification|verify.?human/i;
const LOW_VALUE_FORM_ACTION = /feedback|custom[_-]?scopes?|newsletter|subscribe|signup|sign[_-]?up|survey|report[_-]?(?:abuse|content)?/i;

// JSON-body request templating (POST/PUT APIs like YouTube InnerTube / LinkedIn Voyager / Algolia / GraphQL):
// expose only the VARIABLE fields as tool params; the fixed boilerplate (a `context`, client info, etc.) stays
// baked into the replayed body. Without this, a POST tool either drops the body (400) or asks the caller to supply
// `context`. Keys are matched case-insensitively; nesting is followed shallowly (e.g. GraphQL `variables.query`).
const BODY_INPUT_KEY =
  /^(q|query|search|search_?query|search_?term|search_?text|keywords?|term|text|input|prompt|message|continuation|cursor|after|before|offset|page|page_?number|page_?size|start|limit|count|first|num|video_?id|browse_?id|channel_?id|playlist_?id|slug|username|handle|user_?id|product_?id|sku|asin|lat|latitude|lng|lon|longitude|location|near|sort|sort_?by|order|filter|category|tag)$/i;
const BODY_FIXED_KEY =
  /^(context|client|client_?version|client_?name|client_?form_?factor|request_?metadata|internal_?experiment_?flags|consistency_?token_?jars|visitor_?data|user|csn|click_?tracking|tracking_?params|session_?index|capabilities|device_?params|gl|hl|locale|timezone|tz)$|^(x_?goog|sec_?)/i;
const PRIMARY_INPUT_KEY = /^(q|query|search|search_?query|search_?term|search_?text|keywords?|term|text|input|prompt|message)$/i;

type BodyParam = { name: string; key: string; type: "string" | "number"; required: boolean };

/** Walk a parsed JSON body (shallow) collecting variable input fields as templatable params (dotted key paths). */
function collectBodyParams(value: unknown, basePath: string, out: BodyParam[], depth: number): void {
  if (out.length >= 6 || depth > 3 || value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= 6) break;
    const path = basePath ? `${basePath}.${k}` : k;
    if ((typeof v === "string" || typeof v === "number") && BODY_INPUT_KEY.test(k) && !BODY_FIXED_KEY.test(k)) {
      out.push({ name: k, key: path, type: typeof v === "number" ? "number" : "string", required: PRIMARY_INPUT_KEY.test(k) });
    } else if (v && typeof v === "object" && !Array.isArray(v) && !BODY_FIXED_KEY.test(k) && depth < 2) {
      collectBodyParams(v, path, out, depth + 1); // e.g. GraphQL `variables.{...}`
    }
  }
}

// Path segments that carry no semantic meaning in a tool name (API version + generic plumbing). Dropped so
// `/youtubei/v1/search` -> `post_search` and `/voyager/api/graphql` keeps `voyager`/`graphql`, not `api`.
const GENERIC_SEGMENT = /^(v\d+|\d+|api|apis|rest|restli|gql|graphql|service|services|ajax|json|data|public|internal|web|www|mobile|app|backend|gateway)$/i;

function toolName(method: string, urlPattern: string): string {
  const all = urlPattern.split("/").filter((s) => s && !s.startsWith("{"));
  const meaningful = all.filter((s) => !GENERIC_SEGMENT.test(s));
  const segs = meaningful.length ? meaningful : all;
  const base = (segs.slice(-2).join("_") || "endpoint").replace(/[^a-z0-9]+/gi, "_");
  const name = `${method.toLowerCase()}_${base}`.replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  return /^[a-z]/.test(name) ? name : `call_${name}`;
}

function browserTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  steps: unknown[],
  confidence: number,
): unknown {
  return {
    name,
    description,
    inputSchema,
    execution: { kind: "browser", steps },
    confidence,
  };
}

function absoluteFrom(bundle: CaptureBundle, path: string): string {
  try {
    return new URL(path, bundle.url).toString();
  } catch {
    return path;
  }
}

function queryTemplate(url: string, params: { name: string }[]): string {
  if (!params.length) return url;
  const query = params.map((param) => `${encodeURIComponent(param.name)}={{${param.name}}}`).join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function actionableNetworkCapture(cap: CaptureBundle["network"][number]): boolean {
  if (String(cap.method || "").toUpperCase() === "HEAD") return false;
  try {
    const url = new URL(cap.rawUrl);
    if (NOISY_HOST.test(url.hostname)) return false;
    if (NOISY_PATH.test(url.pathname)) return false;
    if (STATIC_ASSET.test(url.pathname)) return false;
  } catch {
    /* malformed rawUrl: fall through to tool generation */
  }
  // Drop media/font/image/beacon responses - they're assets, not callable JSON/text APIs.
  return !NOISY_CTYPE.test(cap.contentType || "");
}

/** eTLD+1 approximation by last two labels: cnn.com from www.cnn.com / bolt.api.cnn.com. */
function registrableDomain(hostname: string): string {
  const labels = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
}

function isSameSite(rawUrl: string, pageDomain: string): boolean {
  try {
    return registrableDomain(new URL(rawUrl).hostname) === pageDomain;
  } catch {
    return false;
  }
}

// Same-site endpoints are kept first; cross-site fills the rest, capped so a media/ad-heavy page can't bury the real tools.
const MAX_NETWORK_TOOLS = 30;
const MAX_CROSS_SITE_TOOLS = 6;

function fieldText(field: Pick<PageField, "name" | "label" | "placeholder" | "type">): string {
  return [field.name, field.label, field.placeholder, field.type].filter(Boolean).join(" ").toLowerCase();
}

function browserStepForField(field: PageField): { action: string; target: { role: string; selector: string }; value: string } | null {
  if (!field.selector) return null;
  if (field.type === "select") {
    return {
      action: "selectOption",
      target: { role: "select", selector: field.selector },
      value: `{{${field.name}}}`,
    };
  }
  return {
    action: "fill",
    target: { role: field.type || "input", selector: field.selector },
    value: `{{${field.name}}}`,
  };
}

function submitStepsForForm(form: PageForm): { action: string; target?: { role: string; selector: string }; value?: string }[] {
  if (form.submitSelector) {
    return [{ action: "click", target: { role: "button", selector: form.submitSelector } }];
  }
  const firstField = form.fields.find((field: PageField) => field.selector);
  if (!firstField?.selector) return [];
  return [{ action: "pressKey", target: { role: firstField.type || "input", selector: firstField.selector }, value: "Enter" }];
}

function inferTravelFieldMap(form: PageForm): Record<string, PageField> | null {
  const mapping: Record<string, PageField> = {};
  for (const field of form.fields) {
    const text = fieldText(field);
    if (!mapping.origin && /\b(from|origin|leaving|depart(?:ing|ure)? from)\b/.test(text)) mapping.origin = field;
    else if (!mapping.destination && /\b(to|destination|arriv(?:e|al)|going to)\b/.test(text)) mapping.destination = field;
    else if (!mapping.depart_date && /\b(depart|outbound|leaving date|depart date)\b/.test(text)) mapping.depart_date = field;
    else if (!mapping.return_date && /\b(return|inbound|return date)\b/.test(text)) mapping.return_date = field;
    else if (!mapping.cabin && /\b(cabin|class)\b/.test(text)) mapping.cabin = field;
    else if (!mapping.passengers && /\b(passengers?|travell?ers?|guests?)\b/.test(text)) mapping.passengers = field;
  }
  return mapping.origin && mapping.destination ? mapping : null;
}

// Network captures -> tools (path params required, query params optional)
function toolsFromNetwork(bundle: CaptureBundle): unknown[] {
  let pageDomain = "";
  try {
    pageDomain = registrableDomain(new URL(bundle.url).hostname);
  } catch {
    /* no page domain - treat everything as cross-site */
  }
  // Prefer the site's own API over third-party hosts; bound cross-site noise; cap overall.
  const actionable = bundle.network.filter(actionableNetworkCapture);
  const sameSite = pageDomain ? actionable.filter((c) => isSameSite(c.rawUrl, pageDomain)) : [];
  const crossSite = pageDomain ? actionable.filter((c) => !isSameSite(c.rawUrl, pageDomain)) : actionable;
  const ordered = [...sameSite, ...crossSite.slice(0, MAX_CROSS_SITE_TOOLS)].slice(0, MAX_NETWORK_TOOLS);
  return ordered.flatMap((cap) => {
    const properties: Record<string, unknown> = {};
    const paramMapping: Record<string, { in: string; key: string }> = {};
    const required: string[] = [];

    for (const m of cap.urlPattern.matchAll(/\{(\w+)\}/g)) {
      const p = m[1]!;
      properties[p] = { type: "string" };
      paramMapping[p] = { in: "path", key: p };
      required.push(p);
    }
    // Query params come from the rawUrl (urlPattern strips the query). Optional - so a caller never has to
    // supply tracking junk; real inputs (q, page, ...) are available when wanted.
    try {
      const q = new URL(cap.rawUrl).searchParams;
      for (const key of new Set(q.keys())) {
        if (isTracking(key) || paramMapping[key]) continue;
        properties[key] = { type: "string" };
        paramMapping[key] = { in: "query", key };
      }
    } catch {
      /* malformed rawUrl - skip query extraction */
    }
    // POST/PUT JSON body: replay the captured body, exposing only its VARIABLE fields as params (fixed
    // boilerplate - an InnerTube/GraphQL `context`, client info - stays baked into the replayed body). Fall back
    // to the inferred schema keys when we couldn't capture the real body (older bundles / non-JSON).
    let hasPrimaryBodyInput = false;
    if (cap.requestBody) {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(cap.requestBody);
      } catch {
        parsedBody = undefined;
      }
      const found: BodyParam[] = [];
      if (parsedBody !== undefined) collectBodyParams(parsedBody, "", found, 0);
      for (const p of found) {
        const name = properties[p.name] ? `body_${p.name}` : p.name;
        properties[name] = { type: p.type };
        paramMapping[name] = { in: "body", key: p.key };
        if (p.required) {
          if (!required.includes(name)) required.push(name);
          hasPrimaryBodyInput = true;
        }
      }
    } else {
      const bodySchema = cap.requestBodySchema as { properties?: Record<string, unknown> } | undefined;
      for (const key of Object.keys(bodySchema?.properties ?? {}).slice(0, 12)) {
        if (paramMapping[key]) continue;
        properties[key] = bodySchema?.properties?.[key] ?? { type: "string" };
        paramMapping[key] = { in: "body", key };
      }
    }

    const fixedNoInputRead =
      Object.keys(properties).length === 0 &&
      String(cap.method || "GET").toUpperCase() === "GET" &&
      !/[/{](?:id|asin|sku|product|item|search|query|results?|flight|hotel|car)/i.test(cap.urlPattern);
    if (fixedNoInputRead) return [];

    return [{
      name: toolName(cap.method, cap.urlPattern),
      description: hasPrimaryBodyInput
        ? `${cap.method} ${cap.urlPattern} (observed API; replays the site's request with your inputs)`
        : `${cap.method} ${cap.urlPattern} (observed API call)`,
      inputSchema: { type: "object", properties, required },
      execution: { kind: "http", request: cap, paramMapping },
      confidence: hasPrimaryBodyInput ? 0.62 : 0.55,
    }];
  });
}

function toolsFromAnalyzedForms(bundle: CaptureBundle, analysis: PageAnalysis): unknown[] {
  return analysis.forms.slice(0, 6).flatMap((form: HtmlFormSummary) => {
    if (form.purpose === "auth" || form.fields.length === 0) return [];
    if (CHALLENGE_FORM.test(form.action) || form.fields.some((field) => CHALLENGE_FORM.test(`${field.name} ${field.placeholder ?? ""}`))) return [];
    if (LOW_VALUE_FORM_ACTION.test(form.action) && form.purpose !== "search") return [];
    if (form.method === "GET" && form.purpose !== "search" && form.fields.every((field) => !field.required)) return [];
    let action: URL;
    try {
      action = new URL(form.action, bundle.url);
    } catch {
      return [];
    }
    if (action.protocol !== "http:" && action.protocol !== "https:") return [];

    const isSearch = form.purpose === "search";
    const name = isSearch ? "search" : toolName(form.method, action.pathname);
    const where = form.method === "POST" ? "body" : "query";
    const properties: Record<string, unknown> = {};
    const paramMapping: Record<string, { in: string; key: string }> = {};
    const required: string[] = [];
    for (const field of form.fields.slice(0, 8)) {
      properties[field.name] = { type: "string" };
      paramMapping[field.name] = { in: where, key: field.name };
      if (field.required) required.push(field.name);
    }

    return [{
      name,
      description: isSearch
        ? `Search ${action.host} (submits the page's search form).`
        : `Submit the ${form.method} form at ${action.pathname} on ${action.host}.`,
      inputSchema: { type: "object", properties, required },
      execution: {
        kind: "http",
        request: {
          method: form.method,
          urlPattern: action.pathname || "/",
          rawUrl: action.toString(),
          requestHeaders: { accept: "text/html" },
          statusCode: 200,
          contentType: "text/html",
        },
        paramMapping,
      },
      confidence: isSearch ? 0.54 : 0.5,
    }];
  });
}

function toolsFromHtmlAnalysis(bundle: CaptureBundle): unknown[] {
  try {
    const analysis = analyzeBundleHtml(bundle);
    const formTools = toolsFromAnalyzedForms(bundle, analysis);
    const detailTools = analysis.detailLinkPatterns.map((pattern) => ({
      name: pattern.name,
      description: pattern.description,
      inputSchema: {
        type: "object",
        properties: {
          [pattern.paramName]: { type: "string" },
        },
        required: [pattern.paramName],
      },
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
        paramMapping: {
          [pattern.paramName]: { in: "path", key: pattern.paramName },
        },
      },
      confidence: pattern.confidence,
    }));
    const queryTools = analysis.queryLinkPatterns.map((pattern) => ({
      name: pattern.name,
      description: pattern.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(pattern.params.map((param) => [param.name, { type: "string" }])),
        required: pattern.params.filter((param) => param.required).map((param) => param.name),
      },
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
        paramMapping: Object.fromEntries(pattern.params.map((param) => [param.name, { in: "query", key: param.name }])),
      },
      confidence: pattern.confidence,
    }));
    const searchActions = analysis.searchActions.map((pattern) => ({
      name: pattern.name,
      description: pattern.description,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
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
        paramMapping: {
          query: { in: "query", key: pattern.queryParam },
        },
      },
      confidence: pattern.confidence,
    }));
    return [...formTools, ...searchActions, ...queryTools, ...detailTools, ...structuredBrowserTools(bundle, analysis)];
  } catch {
    return [];
  }
}

function structuredBrowserTools(bundle: CaptureBundle, analysis = analyzeBundleHtml(bundle)): unknown[] {
  const isTravel = analysis.likelyPageKinds.includes("travel");
  const tools: unknown[] = [
    browserTool(
      "extract_page_metadata",
      "Open the page in a browser and return structured JSON metadata, headings, and visible links.",
      { type: "object", properties: {} },
      [
        { action: "navigate", value: bundle.url },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:metadata" },
      ],
      0.56,
    ),
  ];

  if (isTravel) {
    tools.push(
      browserTool(
        "list_travel_options",
        "Open the current travel results page in a browser and return structured route, fare, and timing results when present.",
        { type: "object", properties: {} },
        [
          { action: "navigate", value: bundle.url },
          { action: "waitFor", target: { role: "page", selector: "body" } },
          { action: "extract", value: "json:listing" },
        ],
        0.65,
      ),
    );
  }

  // Generic listing extractor: a page that INDEXES a repeated item collection (it has detail-link templates,
  // or reads as a product/results listing) should expose a structured listing tool, not just page metadata.
  // codegen's json:listing extractor finds the repeated cards at runtime (works for catalogs, feeds, search
  // results, post lists). Same-URL/same-mode duplicates are deduped downstream against list_search_results etc.
  const isListingPage = !isTravel && (analysis.detailLinkPatterns.length >= 1 || analysis.likelyPageKinds.includes("product_listing"));
  if (isListingPage) {
    tools.push(
      browserTool(
        "list_page_items",
        "Open this page in a browser and return its repeated items (catalog cards, search results, posts, listings) as structured JSON records.",
        { type: "object", properties: {} },
        [
          { action: "navigate", value: bundle.url },
          { action: "waitFor", target: { role: "page", selector: "body" } },
          { action: "extract", value: "json:listing" },
        ],
        0.6,
      ),
    );
  }

  const detailPattern = analysis.detailLinkPatterns[0];
  if (detailPattern && !isTravel && (detailPattern.name === "get_product_page" || detailPattern.name === "get_item_page")) {
    const detailUrl = absoluteFrom(bundle, detailPattern.urlPattern).replace(
      `{${detailPattern.paramName}}`,
      `{{${detailPattern.paramName}}}`,
    );
    tools.push(
      browserTool(
        detailPattern.paramName === "asin" || detailPattern.name === "get_product_page" ? "get_product_details" : "get_item_details",
        "Open a detail page in a browser and return structured JSON fields such as title, price, availability, and rating when present.",
        {
          type: "object",
          properties: { [detailPattern.paramName]: { type: "string" } },
          required: [detailPattern.paramName],
        },
        [
          { action: "navigate", value: detailUrl },
          { action: "waitFor", target: { role: "page", selector: "body" } },
          { action: "extract", value: "json:product" },
        ],
        Math.max(detailPattern.confidence, 0.66),
      ),
    );
  } else if (!isTravel && analysis.likelyPageKinds.includes("product_detail")) {
    tools.push(
      browserTool(
        "get_product_details",
        "Open the current product page in a browser and return structured JSON fields such as title, price, availability, and rating when present.",
        { type: "object", properties: {} },
        [
          { action: "navigate", value: bundle.url },
          { action: "waitFor", target: { role: "page", selector: "body" } },
          { action: "extract", value: "json:product" },
        ],
        0.64,
      ),
    );
  }

  const searchPattern = analysis.searchActions[0] ?? analysis.queryLinkPatterns.find((pattern) => pattern.name === "search");
  if (searchPattern) {
    const params =
      "queryParam" in searchPattern
        ? [{ name: "query", required: true }, { name: "page", required: false }]
        : searchPattern.params;
    const browserUrl =
      "queryParam" in searchPattern
        ? queryTemplate(absoluteFrom(bundle, searchPattern.urlPattern), [{ name: "query" }, { name: "page" }])
            .replace("query={{query}}", `${searchPattern.queryParam}={{query}}`)
            .replace("page={{page}}", "page={{page}}")
        : queryTemplate(absoluteFrom(bundle, searchPattern.urlPattern), params);
    tools.push(
      browserTool(
        "list_search_results",
        "Run a site search in a browser and return structured JSON search results with titles, URLs, prices, and ratings when present.",
        {
          type: "object",
          properties: Object.fromEntries(params.map((param) => [param.name, { type: "string" }])),
          required: params.filter((param) => param.required).map((param) => param.name),
        },
        [
          { action: "navigate", value: browserUrl },
          { action: "waitFor", target: { role: "page", selector: "body" } },
          { action: "extract", value: "json:listing" },
        ],
        0.67,
      ),
    );
  }

  for (const form of (bundle.page?.forms ?? []) as PageForm[]) {
    const travelFields = inferTravelFieldMap(form);
    if (travelFields) {
      const properties: Record<string, unknown> = {
        origin: { type: "string" },
        destination: { type: "string" },
      };
      const required = ["origin", "destination"];
      for (const [name, field] of Object.entries(travelFields)) {
        if (name === "origin" || name === "destination") continue;
        properties[name] = { type: "string" };
        if (field.required) required.push(name);
      }
      const steps = [
        { action: "navigate", value: bundle.url },
        ...Object.entries(travelFields)
          .map(([name, field]) => {
            const step = browserStepForField({ ...field, name });
            return step ? { ...step, value: `{{${name}}}` } : null;
          })
          .filter(Boolean),
        ...submitStepsForForm(form),
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:listing" },
      ];
      tools.push(
        browserTool(
          "search_travel_options",
          "Use the page's live travel search UI in the current tab to search routes and return structured results.",
          { type: "object", properties, required },
          steps,
          0.7,
        ),
      );
    }

    if (form.purpose !== "search" || !form.fields.length) continue;
    const properties = Object.fromEntries(form.fields.map((field: PageField) => [field.name, { type: "string" }]));
    const required = form.fields.filter((field: PageField) => field.required).map((field: PageField) => field.name);
    const steps = [
      { action: "navigate", value: bundle.url },
      ...form.fields
        .map((field: PageField) => browserStepForField(field))
        .filter(Boolean),
      ...submitStepsForForm(form),
      { action: "waitFor", target: { role: "page", selector: "body" } },
      { action: "extract", value: "json:listing" },
    ];
    tools.push(
      browserTool(
        "search_in_browser",
        "Use the page's live search UI in a browser and return structured JSON results. Useful for JS-driven search forms.",
        { type: "object", properties, required },
        steps,
        0.63,
      ),
    );
    break;
  }

  const actions = (bundle.page?.actions ?? []) as PageAction[];
  const actionTool = (name: string, description: string, matcher: RegExp, confidence: number): unknown | null => {
    const action = actions.find((entry) => matcher.test(entry.label));
    if (!action?.selector) return null;
    return browserTool(
      name,
      description,
      { type: "object", properties: {} },
      [
        { action: "click", target: { role: action.kind || "button", selector: action.selector } },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:metadata" },
      ],
      confidence,
    );
  };

  const nextPage = actionTool(
    "go_to_next_page",
    "Click the page's Next or Show more control in the current tab and return the updated page state.",
    /\b(next|show more|load more|more results)\b/i,
    0.62,
  );
  if (nextPage) tools.push(nextPage);

  const prevPage = actionTool(
    "go_to_previous_page",
    "Click the page's Previous or Back results control in the current tab and return the updated page state.",
    /\b(previous|prev|back results)\b/i,
    0.58,
  );
  if (prevPage) tools.push(prevPage);

  const addToCart = actionTool(
    "add_to_cart",
    "Click the page's Add to cart button in the current tab and return the updated page state.",
    /\b(add to cart|add to basket)\b/i,
    0.7,
  );
  if (addToCart) tools.push(addToCart);

  const openCart = actionTool(
    "open_cart",
    "Open the page's cart or basket in the current tab and return the updated page state.",
    /\b(cart|basket|view cart)\b/i,
    0.61,
  );
  if (openCart) tools.push(openCart);

  return tools;
}

function contentTool(bundle: CaptureBundle): unknown {
  let path = "/";
  try {
    path = new URL(bundle.url).pathname || "/";
  } catch {
    /* keep "/" */
  }
  return {
    name: "fetch_page_content",
    description: `Fetch the page content (readable text) from ${bundle.url}${bundle.meta.title ? ` - ${bundle.meta.title}` : ""}.`,
    inputSchema: { type: "object", properties: {} },
    execution: {
      kind: "http",
      request: {
        method: "GET",
        urlPattern: path,
        rawUrl: bundle.url,
        requestHeaders: { accept: "text/html" },
        statusCode: 200,
        contentType: "text/html",
      },
      paramMapping: {},
    },
    confidence: 0.5,
  };
}

/** All heuristic tools for a bundle: content (floor) + network + forms. inferTools dedups by name. */
export function heuristicTools(bundle: CaptureBundle): unknown[] {
  return [contentTool(bundle), ...toolsFromHtmlAnalysis(bundle), ...toolsFromNetwork(bundle)];
}

export class HeuristicInferenceClient implements InferenceClient {
  async proposeTools(bundle: CaptureBundle): Promise<string> {
    return JSON.stringify(heuristicTools(bundle));
  }
}

/** Heuristic heal: re-propose the failing tool from a fresh snapshot (matches by name). */
export class HeuristicHealClient implements HealClient {
  async proposeHeal(failingTool: { name: string }, bundle: CaptureBundle): Promise<string> {
    const candidates = heuristicTools(bundle) as { name: string }[];
    const match = candidates.find((t) => t.name === failingTool.name) ?? candidates[0];
    return JSON.stringify(match ?? {});
  }
}
