import type { BrowserStep, CaptureBundle, ParamMapping, ToolDefinition } from "@mcp/types";

function originFor(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostFor(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function httpTool(
  tool: Pick<ToolDefinition, "name" | "description" | "inputSchema" | "confidence"> & {
    method?: string;
    urlPattern: string;
    rawUrl: string;
    paramMapping: ParamMapping;
  },
): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execution: {
      kind: "http",
      request: {
        method: tool.method ?? "GET",
        urlPattern: tool.urlPattern,
        rawUrl: tool.rawUrl,
        requestHeaders: { accept: "text/html" },
        statusCode: 200,
        contentType: "text/html",
      },
      paramMapping: tool.paramMapping,
    },
    confidence: tool.confidence,
  };
}

function browserTool(
  tool: Pick<ToolDefinition, "name" | "description" | "inputSchema" | "confidence"> & {
    steps: BrowserStep[];
  },
): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execution: {
      kind: "browser",
      steps: tool.steps,
    },
    confidence: tool.confidence,
  };
}

function amazonTools(bundle: CaptureBundle): ToolDefinition[] {
  const host = hostFor(bundle.url);
  if (!/(^|\.)amazon\./.test(host)) return [];
  const origin = originFor(bundle.url);
  if (!origin) return [];

  return [
    httpTool({
      name: "search_products",
      description: "Search Amazon products by keyword and return the readable search results page.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product search keywords." },
          page: { type: "string", description: "Optional search results page number." },
        },
        required: ["query"],
      },
      urlPattern: "/s",
      rawUrl: `${origin}/s`,
      paramMapping: {
        query: { in: "query", key: "k" },
        page: { in: "query", key: "page" },
      },
      confidence: 0.72,
    }),
    httpTool({
      name: "get_product_page",
      description: "Fetch an Amazon product detail page by ASIN and return readable product page text.",
      inputSchema: {
        type: "object",
        properties: {
          asin: { type: "string", description: "Amazon ASIN, for example B08N5WRWNW." },
        },
        required: ["asin"],
      },
      urlPattern: "/dp/{asin}",
      rawUrl: `${origin}/dp/B000000000`,
      paramMapping: {
        asin: { in: "path", key: "asin" },
      },
      confidence: 0.68,
    }),
    browserTool({
      name: "list_search_results",
      description: "Open Amazon search results in a browser and return structured JSON results with titles, URLs, prices, and ratings when present.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product search keywords." },
          page: { type: "string", description: "Optional search results page number." },
        },
        required: ["query"],
      },
      steps: [
        { action: "navigate", value: `${origin}/s?k={{query}}&page={{page}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:listing" },
      ],
      confidence: 0.8,
    }),
    browserTool({
      name: "get_product_details",
      description: "Open an Amazon product page in a browser and return structured JSON fields such as title, price, availability, and rating.",
      inputSchema: {
        type: "object",
        properties: {
          asin: { type: "string", description: "Amazon ASIN, for example B08N5WRWNW." },
        },
        required: ["asin"],
      },
      steps: [
        { action: "navigate", value: `${origin}/dp/{{asin}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:product" },
      ],
      confidence: 0.79,
    }),
  ];
}

/**
 * Deterministic, domain-aware tools. These are merged with model/heuristic inference, so hard sites still
 * get useful tools when a bot wall or weak snapshot prevents the model from discovering obvious actions.
 */
export function siteRecipeTools(bundle: CaptureBundle): ToolDefinition[] {
  return [...amazonTools(bundle)];
}
