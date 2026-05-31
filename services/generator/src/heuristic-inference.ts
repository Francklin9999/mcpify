import type { CaptureBundle, PageAction, PageField, PageForm } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";

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
const NOISY_HOST = /(google-analytics|doubleclick|newrelic|nr-data|segment|sentry|hotjar|amplitude|optimizely|facebook|bing|adsrvr|demdex|datadog)/i;
const NOISY_PATH = /(?:^|\/)(collect|collector|analytics|tracking|telemetry|metrics|events?|pagead|conversion|viewthroughconversion|newrelic|nrjs|jserrors|experimentchokepoint|ccm|rmkt|tallyman|loginwebevent|funnel)(?:\/|$)|\/g\/collect\b|\/sid\.json\b/i;
const STATIC_ASSET = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webmanifest)$/i;

const SEARCH_FIELDS = new Set(["q", "query", "search", "s", "keyword", "keywords", "term", "k", "_nkw", "search_term_string", "text"]);

function toolName(method: string, urlPattern: string): string {
  const segs = urlPattern.split("/").filter((s) => s && !s.startsWith("{"));
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
  return !/beacon|analytics|telemetry|tracking/i.test(cap.contentType || "");
}

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
  return bundle.network.filter(actionableNetworkCapture).flatMap((cap) => {
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
    const bodySchema = cap.requestBodySchema as { properties?: Record<string, unknown> } | undefined;
    for (const key of Object.keys(bodySchema?.properties ?? {}).slice(0, 12)) {
      if (paramMapping[key]) continue;
      properties[key] = bodySchema?.properties?.[key] ?? { type: "string" };
      paramMapping[key] = { in: "body", key };
    }

    const fixedNoInputRead =
      Object.keys(properties).length === 0 &&
      String(cap.method || "GET").toUpperCase() === "GET" &&
      !/[/{](?:id|asin|sku|product|item|search|query|results?|flight|hotel|car)/i.test(cap.urlPattern);
    if (fixedNoInputRead) return [];

    return [{
      name: toolName(cap.method, cap.urlPattern),
      description: `${cap.method} ${cap.urlPattern} (observed API call)`,
      inputSchema: { type: "object", properties, required },
      execution: { kind: "http", request: cap, paramMapping },
      confidence: 0.55,
    }];
  });
}

// HTML <form>s -> action tools (the high-signal static-page case: search boxes)
type FormField = { name: string; required: boolean };

function parseForms(html: string, pageUrl: string): unknown[] {
  const tools: unknown[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  let count = 0;
  while ((fm = formRe.exec(html)) && count < 6) {
    const attrs = fm[1] ?? "";
    const inner = fm[2] ?? "";
    // Skip login/auth forms - a tool needing credentials violates the session/legal stance.
    if (/type\s*=\s*["']?password/i.test(inner)) continue;

    const method = (/method\s*=\s*["']?\s*post/i.test(attrs) ? "POST" : "GET") as "GET" | "POST";
    const actionRaw = attrs.match(/action\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    let action: URL;
    try {
      action = new URL(actionRaw || pageUrl, pageUrl);
    } catch {
      continue;
    }
    // Only http(s) actions yield a usable tool. A `javascript:`/`mailto:`/`tel:` action (common on
    // JS-driven forms) would fetch() to nothing - skip rather than emit a broken tool.
    if (action.protocol !== "http:" && action.protocol !== "https:") continue;

    // Visible, named fields only. Exclude hidden/submit/button/image (incl. CSRF tokens the model can't supply).
    const fields: FormField[] = [];
    for (const im of inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const tag = im[2] ?? "";
      const name = tag.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!name) continue;
      const type = (tag.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "text").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file"].includes(type)) continue;
      const isSearch = SEARCH_FIELDS.has(name.toLowerCase());
      fields.push({ name, required: isSearch });
      if (fields.length >= 8) break;
    }
    if (fields.length === 0) continue;

    const isSearch = fields.some((f) => f.required);
    const name = isSearch ? "search" : toolName(method, action.pathname);
    const properties: Record<string, unknown> = {};
    const paramMapping: Record<string, { in: string; key: string }> = {};
    const required: string[] = [];
    const where = method === "POST" ? "body" : "query";
    for (const f of fields) {
      properties[f.name] = { type: "string" };
      paramMapping[f.name] = { in: where, key: f.name };
      if (f.required) required.push(f.name);
    }

    tools.push({
      name,
      description: isSearch
        ? `Search ${action.host} (submits the page's search form).`
        : `Submit the ${method} form at ${action.pathname} on ${action.host}.`,
      inputSchema: { type: "object", properties, required },
      execution: {
        kind: "http",
        request: {
          method,
          urlPattern: action.pathname || "/",
          rawUrl: action.toString(),
          requestHeaders: { accept: "text/html" },
          statusCode: 200,
          contentType: "text/html",
        },
        paramMapping,
      },
      confidence: 0.5,
    });
    count++;
  }
  return tools;
}

function toolsFromForms(bundle: CaptureBundle): unknown[] {
  try {
    return parseForms(bundle.dom.html, bundle.url);
  } catch {
    return []; // brittle HTML parsing must never crash the worker; fall back to content/network tools
  }
}

function toolsFromHtmlAnalysis(bundle: CaptureBundle): unknown[] {
  try {
    const analysis = analyzeBundleHtml(bundle);
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
    return [...searchActions, ...queryTools, ...detailTools, ...structuredBrowserTools(bundle, analysis)];
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

  const detailPattern = analysis.detailLinkPatterns[0];
  if (detailPattern && !isTravel) {
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
  return [contentTool(bundle), ...toolsFromForms(bundle), ...toolsFromHtmlAnalysis(bundle), ...toolsFromNetwork(bundle)];
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
