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
      name: "go_to_next_amazon_results_page",
      description: "Open the next Amazon search results page for a query and return structured JSON results.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product search keywords." },
          page: { type: "string", description: "Next results page number, for example 2." },
        },
        required: ["query", "page"],
      },
      steps: [
        { action: "navigate", value: `${origin}/s?k={{query}}&page={{page}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:listing" },
      ],
      confidence: 0.82,
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
    browserTool({
      name: "open_amazon_product_url_and_extract_details",
      description: "Open an Amazon product URL from search results and return structured product details.",
      inputSchema: {
        type: "object",
        properties: {
          product_url: { type: "string", description: "Full Amazon product URL from a search result." },
        },
        required: ["product_url"],
      },
      steps: [
        { action: "navigate", value: "{{product_url}}" },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "json:product" },
      ],
      confidence: 0.81,
    }),
  ];
}

function linkedinTools(bundle: CaptureBundle): ToolDefinition[] {
  const host = hostFor(bundle.url);
  if (!/(^|\.)linkedin\.com$/.test(host)) return [];
  const origin = originFor(bundle.url);
  if (!origin) return [];

  return [
    browserTool({
      name: "search_linkedin_all_results",
      description: "Search LinkedIn all results for a person, company, post, or keyword and return readable page text.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "LinkedIn search keywords, for example a person's name." },
        },
        required: ["query"],
      },
      steps: [
        { action: "navigate", value: `${origin}/search/results/all/?keywords={{query}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "page_text" },
      ],
      confidence: 0.86,
    }),
    browserTool({
      name: "search_linkedin_people",
      description: "Search LinkedIn people results for a person's name and return readable page text.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Person name or people-search keywords." },
        },
        required: ["query"],
      },
      steps: [
        { action: "navigate", value: `${origin}/search/results/people/?keywords={{query}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "page_text" },
      ],
      confidence: 0.87,
    }),
    browserTool({
      name: "go_to_next_linkedin_results_page",
      description: "Open a specific LinkedIn search results page for the same query and return readable page text.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "LinkedIn search keywords." },
          page: { type: "string", description: "Results page number, for example 2." },
        },
        required: ["query", "page"],
      },
      steps: [
        { action: "navigate", value: `${origin}/search/results/all/?keywords={{query}}&page={{page}}` },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "page_text" },
      ],
      confidence: 0.84,
    }),
    browserTool({
      name: "open_linkedin_profile_and_extract_metadata",
      description: "Open a LinkedIn profile URL and return readable profile text for experience, education, headline, and timeline analysis.",
      inputSchema: {
        type: "object",
        properties: {
          profile_url: { type: "string", description: "Full LinkedIn profile URL, usually under /in/." },
        },
        required: ["profile_url"],
      },
      steps: [
        { action: "navigate", value: "{{profile_url}}" },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "page_text" },
      ],
      confidence: 0.87,
    }),
    browserTool({
      name: "open_linkedin_post_and_extract_metadata",
      description: "Open a LinkedIn post or activity URL and return readable post text and surrounding metadata.",
      inputSchema: {
        type: "object",
        properties: {
          post_url: { type: "string", description: "Full LinkedIn post or activity URL." },
        },
        required: ["post_url"],
      },
      steps: [
        { action: "navigate", value: "{{post_url}}" },
        { action: "waitFor", target: { role: "page", selector: "body" } },
        { action: "extract", value: "page_text" },
      ],
      confidence: 0.85,
    }),
  ];
}

/**
 * Deterministic, domain-aware tools. These are merged with model/heuristic inference, so hard sites still
 * get useful tools when a bot wall or weak snapshot prevents the model from discovering obvious actions.
 */
export function siteRecipeTools(bundle: CaptureBundle): ToolDefinition[] {
  return [...amazonTools(bundle), ...linkedinTools(bundle)];
}
