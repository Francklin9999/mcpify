/**
 * Shared prompt strings for all LLM inference clients (OpenAI, Claude, Gemini).
 * Keeping them here prevents drift between providers.
 */

export const TOOL_SYSTEM_PROMPT = `You convert observed website structure and traffic into MCP tool definitions.
Given a page URL, normalized HTML analysis, selectors, and observed network calls, output ONLY a JSON object of the form
{ "tools": [ <tool>, ... ] }. Each tool: { "name": snake_case, "description": string,
"inputSchema": <JSON Schema object>, "execution": either
{ "kind": "http", "request": <the NetworkCapture>,
"paramMapping": { param: { "in": "path"|"query"|"header"|"body", "key": string } } }
or
{ "kind": "browser", "steps": [
  { "action": "navigate", "value": "https://..." },
  { "action": "fill"|"click"|"waitFor"|"extract", "target": { "role": string, "selector": string, "fallbackSelectors"?: string[] }, "value"?: string }
] },
"confidence": number in [0,1] }.
Prefer tools that map to real user tasks: search, list results, fetch detail pages, filters, pagination,
and structured extraction. Prefer observed network calls when available. Otherwise derive safe public GET/POST
tools or browser-step tools from visible forms, page selectors, canonical links, repeated detail-link patterns,
and app-state hints in pageAnalysis. Use browser tools when the page is JS-driven or when the output should be
structured JSON. For browser extract steps, prefer value "json:metadata", "json:product", or "json:listing".
Skip login, password, checkout, account, and credential/session-only actions. Output JSON only, no prose.`;

export const INCREMENTAL_NOTE = `INCREMENTAL MODE: you are EXTENDING an existing MCP server. The payload contains only NEW
page material discovered since the last pass, plus "knownToolNames" — tools that ALREADY exist. Propose ONLY
genuinely-new, distinct capabilities for the new material. Do NOT restate, rename, or duplicate an existing
tool (e.g. do not add "find_products" when "search_products" already exists). If nothing is genuinely new,
output { "tools": [] }.`;

export const HEAL_SYSTEM_PROMPT = `You repair a single broken MCP tool. Given the current (broken) tool, a fresh
DOM/network snapshot of its source page, and the observed failure, output ONLY the corrected tool as a
single JSON object with the SAME "name". Keep the same shape as the input tool; fix the selector, request,
or paramMapping that broke. Output JSON only, no prose.`;
