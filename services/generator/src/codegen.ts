import type { ToolDefinition, GeneratedServerArtifact } from "@mcp/types";
import { emitGateRuntime } from "./browser-gate.js";
import { emitOpenCliBrowsingRuntime, type BrowserBackend } from "./opencli-backend.js";
import { emitPopupRuntime } from "./popups.js";

/**
 * Codegen: ToolDefinition[] -> a runnable MCP server artifact (`01 S3`, `services/generator.md`).
 * Emits `server.ts` against the verified @modelcontextprotocol/sdk API (McpServer.registerTool +
 * StdioServerTransport), a claude_code_config.json snippet, and a README. Deterministic.
 */

export interface CodegenInput {
  serverId: string;
  version: number;
  url: string;
  title: string;
  tools: ToolDefinition[];
  /**
   * Emit the generic, snapshot-driven browsing toolkit (browser_navigate/snapshot/click/type/...) so an
   * LLM can drive a persistent session turn-by-turn (navigate, paginate, add to cart, multi-step flows).
   * Defaults to "any browser tool present" when undefined. Set true to force it on for interactive sites.
   */
  browsing?: boolean;
  /**
   * Default browser backend baked into the generated server: "playwright" (standalone headless Chromium, the
   * default) or "opencli" (drives the user's real logged-in Chrome via the opencli Browser Bridge, for dynamic /
   * bot-walled sites). Computed upstream via chooseBrowserBackend(); always overridable at runtime with
   * MCP_BROWSER_BACKEND. Undefined => "playwright".
   */
  dynamicBackend?: BrowserBackend;
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "server";
  } catch {
    return "server";
  }
}

/** JSON Schema (object) -> a zod raw-shape source string, e.g. `{ "id": z.string(), "limit": z.number().optional() }`. */
function zodRawShapeSource(inputSchema: unknown): string {
  const schema = (inputSchema ?? {}) as { properties?: Record<string, { type?: string }>; required?: string[] };
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(props).map(([key, def]) => {
    let zod: string;
    switch (def?.type) {
      case "string": zod = "z.string()"; break;
      case "integer":
      case "number": zod = "z.number()"; break;
      case "boolean": zod = "z.boolean()"; break;
      case "array": zod = "z.array(z.unknown())"; break;
      case "object": zod = "z.record(z.unknown())"; break;
      default: zod = "z.unknown()"; break;
    }
    if (!required.has(key)) zod += ".optional()";
    return `${JSON.stringify(key)}: ${zod}`;
  });
  return `{ ${entries.join(", ")} }`;
}

/** Full templated URL for an http tool: origin(rawUrl) + urlPattern (keeps the {param} path placeholders). */
function urlTemplate(rawUrl: string, urlPattern: string): string {
  try {
    const u = new URL(rawUrl);
    // Keep any fixed query string from the captured URL (e.g. ?prettyPrint=false, ?alt=json, ?key=...) - these
    // are often required by the API. urlPattern is path-only; mapped query params override these at runtime.
    return u.origin + urlPattern + (urlPattern.includes("?") ? "" : u.search);
  } catch {
    return urlPattern;
  }
}

// PUT/PATCH/DELETE are always writes; a POST is a write only if its name/description reads as a mutation
// (so a read-only search/GraphQL POST isn't gated).
const MUTATION_RE =
  /\b(create|creat|update|delete|deletes|remove|removes|destroy|add|adds|insert|submit|save|saves|buy|purchase|order|checkout|pay|payment|send|sends|post|posts|upload|cancel|book|reserve|register|signup|subscribe|unsubscribe|edit|modify|patch|put|set|enable|disable|approve|reject|like|follow|unfollow|vote|comment|rename|move|merge|deploy|publish|revoke|grant|invite)\b/i;

function isWriteHttpTool(tool: ToolDefinition): boolean {
  if (tool.execution.kind !== "http") return false;
  const method = String(tool.execution.request.method || "GET").toUpperCase();
  if (method === "PUT" || method === "PATCH" || method === "DELETE") return true;
  if (method === "POST") return MUTATION_RE.test(tool.name) || MUTATION_RE.test(tool.description);
  return false;
}

/** Merge extra zod entries into a `{ ... }` raw-shape source, skipping keys that already exist. */
function mergeShape(baseShape: string, extras: Array<{ key: string; entry: string }>): string {
  if (!extras.length) return baseShape;
  const inner = baseShape.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  const have = new Set([...inner.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]));
  const additions = extras.filter((e) => !have.has(e.key)).map((e) => `${JSON.stringify(e.key)}: ${e.entry}`);
  const parts = [inner, ...additions].filter((p) => p && p.length);
  return `{ ${parts.join(", ")} }`;
}

function toolRegistration(tool: ToolDefinition): string {
  const baseShape = zodRawShapeSource(tool.inputSchema);
  if (tool.execution.kind === "http") {
    const req = tool.execution.request;
    const write = isWriteHttpTool(tool);
    const json = /json/i.test(req.contentType || "") || /json/i.test(req.requestHeaders?.["accept"] || "");
    const spec = {
      method: req.method,
      urlTemplate: urlTemplate(req.rawUrl, req.urlPattern),
      headers: req.requestHeaders,
      paramMapping: tool.execution.paramMapping,
      requestBody: req.requestBody,
      write,
      json,
    };
    // Write tools gain an optional `dryRun`; read-only JSON tools gain an optional `select` (dot-path projection).
    const extras: Array<{ key: string; entry: string }> = [];
    if (write) extras.push({ key: "dryRun", entry: 'z.boolean().optional().describe("Preview the request (method, URL, body) WITHOUT sending it.")' });
    else if (json) extras.push({ key: "select", entry: 'z.string().optional().describe("Comma-separated dot-paths to project from the JSON response, e.g. \\"id,name,owner.login\\". Omit for the full response.")' });
    const shape = mergeShape(baseShape, extras);
    return `  register(
    ${JSON.stringify(tool.name)},
    { description: ${JSON.stringify(tool.description)}, inputSchema: ${shape} },
    async (args) => callHttp(${JSON.stringify(spec)}, args),
  );`;
  }
  const shape = baseShape;
  const spec = { steps: tool.execution.steps };
  return `  register(
    ${JSON.stringify(tool.name)},
    { description: ${JSON.stringify(tool.description)}, inputSchema: ${shape} },
    async (args) => callBrowser(${JSON.stringify(spec)}, args, browsing),
  );`;
}

/** snake_case names of the generic browsing toolkit, so codegen can skip any that collide with an inferred tool. */
const TOOLKIT_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_back",
  "browser_read_page",
  "browser_extract",
  "browser_dismiss",
  "browser_resume",
] as const;

/**
 * Whether this server ships the browser toolkit (and therefore needs Playwright's Chromium binary). Single
 * source of truth for codegen AND the installers, so the emitted toolkit and the auto-install step agree.
 */
function emitsBrowserToolkit(input: CodegenInput): boolean {
  return input.browsing ?? input.tools.some((t) => t.execution.kind === "browser");
}

/**
 * The fixed browsing toolkit (NOT inferred tools - emitted directly so the frozen `01 S2` ExecutionStrategy
 * union stays untouched). Registered against the same persistent `browsing` session the shortcut tools use,
 * so the model can compose: snapshot -> click(ref) -> snapshot -> ... across many tool calls.
 */
function browsingToolkitRegistrations(input: CodegenInput): string {
  const emit = emitsBrowserToolkit(input);
  if (!emit) return "";
  const inferred = new Set(input.tools.map((t) => t.name));
  const defs: { name: (typeof TOOLKIT_NAMES)[number]; description: string; shape: string; call: string }[] = [
    {
      name: "browser_navigate",
      description:
        "Navigate the shared browser session to a URL (absolute, or relative to this site). Starts the session if needed. Returns a snapshot of the new page's interactive elements.",
      shape: "{ url: z.string() }",
      call: "browsing.navigate(String(args.url))",
    },
    {
      name: "browser_snapshot",
      description:
        "List the current page's interactive elements, each with a [ref] for browser_click/browser_type/browser_select_option, plus the page title, URL and a visible-text excerpt. Call this first, and again after any action - refs change whenever the page changes.",
      shape: "{}",
      call: "browsing.snapshot()",
    },
    {
      name: "browser_click",
      description:
        "Click the element with the given [ref] from the latest browser_snapshot (a link, button, result, 'Add to cart', pagination, etc.). Returns a fresh snapshot after the click.",
      shape: "{ ref: z.string() }",
      call: "browsing.click(String(args.ref))",
    },
    {
      name: "browser_type",
      description:
        "Type text into the input/textarea with the given [ref]. Set submit=true to press Enter afterwards (e.g. to run a search). Returns a fresh snapshot.",
      shape: "{ ref: z.string(), text: z.string(), submit: z.boolean().optional() }",
      call: "browsing.type(String(args.ref), String(args.text), args.submit === true)",
    },
    {
      name: "browser_press_key",
      description:
        "Press a key (Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace). Optionally target a [ref]; otherwise the focused element. Returns a fresh snapshot.",
      shape: "{ key: z.string(), ref: z.string().optional() }",
      call: "browsing.pressKey(String(args.key), args.ref ? String(args.ref) : undefined)",
    },
    {
      name: "browser_select_option",
      description: "Choose an option (by value or visible label) in the <select> with the given [ref]. Returns a fresh snapshot.",
      shape: "{ ref: z.string(), value: z.string() }",
      call: "browsing.selectOption(String(args.ref), String(args.value))",
    },
    {
      name: "browser_back",
      description: "Go back to the previous page in the shared browser session. Returns a fresh snapshot.",
      shape: "{}",
      call: "browsing.back()",
    },
    {
      name: "browser_read_page",
      description: "Return the readable text content of the current page in the shared browser session (no markup).",
      shape: "{}",
      call: "browsing.read()",
    },
    {
      name: "browser_extract",
      description:
        "Extract structured JSON from the current page. mode = 'product' (price/availability/rating/...), 'listing' (search-result cards), 'linkedin_jobs' (LinkedIn job cards/details), or 'metadata' (title/headings/links, the default).",
      shape: "{ mode: z.string().optional() }",
      call: 'browsing.extract(String(args.mode || "metadata"))',
    },
    {
      name: "browser_dismiss",
      description:
        "Dismiss a blocking pop-up on the current page - a cookie/GDPR consent banner or newsletter/consent overlay - by accepting it (curated CMP selectors + consent-scoped accept buttons). Call this when a snapshot shows a consent wall before you can interact. Returns a fresh snapshot. Safe: only clicks consent controls, never page content.",
      shape: "{}",
      call: "(browsing.dismiss ? browsing.dismiss() : browsing.snapshot())",
    },
    {
      name: "browser_resume",
      description:
        "Resume after a PAUSED handoff. If a previous browser tool returned 'PAUSED - human action needed' (a sign-in wall or CAPTCHA), the user completes it in the opened browser window, then you call this to continue. Re-runs the paused action and returns its result - or tells you it's still blocked.",
      shape: "{}",
      call: '(browsing.resume ? browsing.resume() : Promise.resolve("Resume is not available in this session."))',
    },
  ];
  return defs
    .filter((d) => !inferred.has(d.name))
    .map(
      (d) => `  register(
    ${JSON.stringify(d.name)},
    { description: ${JSON.stringify(d.description)}, inputSchema: ${d.shape} },
    async (args) => guardBrowsing(() => ${d.call}),
  );`,
    )
    .join("\n\n");
}

/**
 * Make an attacker-influenceable string (url/title originate from the scraped page / inferred output) safe to
 * embed in a single-line `//` comment or a markdown line: strip JS line terminators and control chars. Without
 * this, a URL containing a newline would close the `//` comment and inject executable code into the generated
 * server.ts the user later runs. (Code sinks like SITE_URL already use JSON.stringify.)
 */
function commentSafe(s: string): string {
  // Replace JS line terminators (LF/CR/U+2028/U+2029) and control chars with a space, so an
  // attacker-influenced url/title cannot break out of the `//` comment into executable code.
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    out += (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) ? " " : ch;
  }
  return out.trim();
}

/**
 * JSON.stringify for embedding a value as a JS string/object literal in generated code, additionally escaping
 * U+2028/U+2029. Those are valid in JSON but are LINE TERMINATORS in JS source, so a raw one inside an emitted
 * string literal could (on some engines) break the literal - this keeps generated code safe across runtimes.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function generateServerSource(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  const registrations = input.tools.map(toolRegistration).join("\n\n");
  const toolkit = browsingToolkitRegistrations(input);
  return `// AUTO-GENERATED MCP server for ${commentSafe(input.url)}
// serverId=${input.serverId} version=${input.version}. Generated by @mcp/generator.
// Runs LOCALLY on your machine. Do not commit secrets; this server calls only public endpoints (v1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type HttpToolSpec = {
  method: string;
  urlTemplate: string;
  headers: Record<string, string>;
  paramMapping: Record<string, { in: "path" | "query" | "header" | "body"; key: string }>;
  requestBody?: string; // captured JSON body to REPLAY (fixed boilerplate kept; body params substituted by key path)
  write?: boolean; // mutates data: gated behind MCP_ALLOW_WRITES + per-call dryRun
  json?: boolean; // JSON response: enables pretty-print + the select projection
};

type BrowserElementRef = {
  role: string;
  selector: string;
  fallbackSelectors?: string[];
};

type BrowserStepSpec = {
  action: "navigate" | "fill" | "click" | "selectOption" | "pressKey" | "waitFor" | "extract";
  target?: BrowserElementRef;
  value?: string;
};

type BrowserToolSpec = {
  steps: BrowserStepSpec[];
};

type StepExecutor = (spec: BrowserToolSpec, args: Record<string, unknown>) => Promise<unknown>;

// The site this server was generated from. The persistent session opens here on first use, and relative
// browser_navigate targets resolve against it.
const SITE_URL = ${jsLiteral(input.url)};
const HTTP_TIMEOUT_MS = Number(process.env.MCP_HTTP_TIMEOUT_MS || 20_000);
const HTTP_MAX_RESPONSE_BYTES = Number(process.env.MCP_HTTP_MAX_RESPONSE_BYTES || 1_000_000);
const DNS_LOOKUP_TIMEOUT_MS = Number(process.env.MCP_DNS_LOOKUP_TIMEOUT_MS || 5_000);
// Idempotent (GET/HEAD) requests retry on network error / 429 / 5xx with exponential backoff; writes never retry.
const HTTP_MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.MCP_HTTP_MAX_RETRIES || 2)));
// Write tools (POST-mutation/PUT/PATCH/DELETE) refuse to fire unless this is set - so an agent can't silently
// mutate the site. Per-call dryRun previews without sending regardless of this flag.
const HTTP_ALLOW_WRITES = process.env.MCP_ALLOW_WRITES === "1";
// The server's own origin. Credentials from the environment are attached ONLY to requests to this origin -
// never leaked cross-origin (e.g. if a redirect or an inferred tool URL points to a third-party host).
const SITE_ORIGIN = (() => { try { return new URL(SITE_URL).origin; } catch { return ""; } })();

function cleanHostname(hostname: string): string {
  return hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function inRange(value: number, base: string, maskBits: number): boolean {
  const baseNum = ipv4ToNumber(base);
  if (baseNum == null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (baseNum & mask);
}

function isPrivateOrReservedIp(address: string): boolean {
  const host = cleanHostname(address);
  if (isIP(host) === 4) {
    const n = ipv4ToNumber(host);
    if (n == null) return true;
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inRange(n, base as string, bits as number));
  }
  if (isIP(host) === 6) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:") || h.startsWith("ff")) return true;
    const mapped = h.match(/^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/);
    if (mapped && mapped[1]) return isPrivateOrReservedIp(mapped[1]);
  }
  return false;
}

async function lookupWithTimeout(hostname: string): Promise<Array<{ address: string }>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), Math.max(100, DNS_LOOKUP_TIMEOUT_MS));
  });
  try {
    return await Promise.race([lookup(hostname, { all: true, verbatim: true }).catch(() => []), timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (process.env.MCP_ALLOW_PRIVATE_HOSTS === "1") return;
  const hostname = cleanHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateOrReservedIp(hostname)) {
    throw new Error("refusing to fetch a private, loopback, reserved, or non-public URL");
  }
  const addresses = await lookupWithTimeout(hostname).catch(() => []);
  if (!addresses.length) throw new Error("refusing to fetch a hostname that does not resolve");
  if (addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
    throw new Error("refusing to fetch a hostname that resolves to a private, loopback, or reserved address");
  }
}

async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large; max " + maxBytes + " bytes");
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("response too large; max " + maxBytes + " bytes");
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large; max " + maxBytes + " bytes");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// Credentials from the environment, attached ONLY to the server's own origin (never sent cross-origin).
// All optional: MCP_AUTH_BEARER -> "Authorization: Bearer <v>"; MCP_API_KEY (+ MCP_API_KEY_HEADER, default
// x-api-key); MCP_AUTH_COOKIE -> "Cookie: <v>"; MCP_AUTH_HEADER -> one or more "Name: Value" lines.
function envAuthHeaders(targetUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  let origin = "";
  try { origin = new URL(targetUrl).origin; } catch { return out; }
  if (SITE_ORIGIN && origin !== SITE_ORIGIN) return out;
  const bearer = process.env.MCP_AUTH_BEARER;
  if (bearer) out["authorization"] = "Bearer " + bearer;
  const apiKey = process.env.MCP_API_KEY;
  if (apiKey) out[String(process.env.MCP_API_KEY_HEADER || "x-api-key").toLowerCase()] = apiKey;
  const cookie = process.env.MCP_AUTH_COOKIE;
  if (cookie) out["cookie"] = cookie;
  const raw = process.env.MCP_AUTH_HEADER;
  if (raw) {
    for (const line of String(raw).split(/\\r?\\n/)) {
      const m = line.match(/^\\s*([A-Za-z0-9!#$%&'*+.^_|~-]+)\\s*[:=]\\s*([\\s\\S]*)$/);
      if (m && m[1]) out[m[1].toLowerCase()] = String(m[2] == null ? "" : m[2]).trim();
    }
  }
  return out;
}

// MCP_AUTH_QUERY="key=value&key2=value2" appended to same-origin URLs (for APIs that key on a query param).
function applyAuthQuery(rawUrl: string): string {
  const raw = process.env.MCP_AUTH_QUERY;
  if (!raw) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (SITE_ORIGIN && u.origin !== SITE_ORIGIN) return rawUrl;
    for (const pair of String(raw).split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      u.searchParams.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
    }
    return u.toString();
  } catch { return rawUrl; }
}

const WRITE_REFUSED_HINT =
  "This tool performs a WRITE (it can modify data on the site) and is disabled by default. To allow it, set " +
  "MCP_ALLOW_WRITES=1 in this server's environment. To preview the exact request WITHOUT sending it, call again with dryRun=true.";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

// Retry-After (delta-seconds or HTTP-date) -> ms, capped at 30s; null when absent/unparseable.
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(30_000, Math.max(0, secs * 1000));
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(30_000, Math.max(0, when - Date.now()));
  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);
}

// Fetch with bounded retries. Idempotent methods (GET/HEAD) retry on network error / 429 / 5xx with backoff
// (honoring Retry-After); writes never retry. A fresh per-attempt timeout signal is applied each try.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (idempotent && attempt < HTTP_MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
        const wait = retryAfterMs(res) ?? backoffMs(attempt);
        try { await (res.body as any)?.cancel?.(); } catch { /* free the socket before retrying */ }
        await sleep(wait);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (idempotent && attempt < HTTP_MAX_RETRIES) { await sleep(backoffMs(attempt)); attempt++; continue; }
      throw err;
    }
  }
}

const BINARY_CTYPE = /(application\\/(pdf|zip|gzip|octet-stream|x-protobuf|wasm|msword|vnd\\.)|image\\/|audio\\/|video\\/|font\\/)/i;

// Project comma-separated dot-paths out of a parsed JSON value (arrays projected element-wise). Best-effort.
function projectJson(value: unknown, select: string): unknown {
  const paths = String(select).split(",").map((s) => s.trim()).filter(Boolean);
  if (!paths.length) return value;
  const pick = (v: any): any => {
    if (Array.isArray(v)) return v.map(pick);
    if (v == null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const path of paths) {
      const segs = path.split(".").map((s) => s.trim()).filter(Boolean);
      let cur: any = v;
      for (const s of segs) cur = cur == null ? undefined : cur[s];
      if (cur !== undefined) out[segs[segs.length - 1] || path] = cur;
    }
    return out;
  };
  return pick(value);
}

// Content-type aware rendering: HTML -> readable text; JSON -> pretty (+ optional projection); otherwise
// passed through. Truncated/invalid JSON falls back to the raw text instead of throwing.
function shapeResponseBody(raw: string, ctype: string, select?: string): string {
  if (/html/i.test(ctype)) return htmlToText(raw);
  if (/json/i.test(ctype)) {
    try {
      let parsed: unknown = JSON.parse(raw);
      if (select) parsed = projectJson(parsed, select);
      return JSON.stringify(parsed, null, 2);
    } catch { return raw; }
  }
  return raw;
}

// Set a (possibly nested, dotted) key path on an object, creating intermediate objects as needed.
function setByPath(obj: Record<string, any>, dotted: string, value: unknown) {
  const parts = String(dotted).split(".").filter((p) => p.length > 0);
  if (!parts.length) return;
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = String(parts[i]);
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[String(parts[parts.length - 1])] = value;
}

async function callHttp(spec: HttpToolSpec, args: Record<string, unknown>) {
  let url = spec.urlTemplate;
  // Seed the query from any fixed params already in the template, so a caller-supplied value OVERRIDES the
  // captured default (set()) instead of appending a duplicate key.
  const tplQ = url.indexOf("?");
  const query = new URLSearchParams(tplQ >= 0 ? url.slice(tplQ + 1) : "");
  if (tplQ >= 0) url = url.slice(0, tplQ);
  const headers: Record<string, string> = { ...spec.headers };
  const bodyEntries: Array<{ key: string; value: unknown }> = [];
  let hasBody = false;
  for (const [param, value] of Object.entries(args)) {
    const m = spec.paramMapping[param];
    if (!m) continue;
    if (m.in === "path") {
      // Replace every {{key}} and {key} (inference is inconsistent about brace style).
      const enc = encodeURIComponent(String(value));
      url = url.split("{{" + m.key + "}}").join(enc).split("{" + m.key + "}").join(enc);
    }
    else if (m.in === "query") query.set(m.key, String(value));
    else if (m.in === "header") headers[m.key] = String(value);
    else { bodyEntries.push({ key: m.key, value }); hasBody = true; }
  }
  const qs = query.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  url = applyAuthQuery(url);
  const init: RequestInit = { method: spec.method, headers };
  if (spec.requestBody !== undefined) {
    // Replay the captured request body verbatim (keeps fixed boilerplate like an API "context"), substituting
    // only the variable fields the caller supplied, each at its captured key path.
    let base: Record<string, any>;
    try { base = JSON.parse(spec.requestBody); } catch { base = {}; }
    for (const e of bodyEntries) setByPath(base, e.key, e.value);
    init.body = JSON.stringify(base);
    headers["content-type"] = headers["content-type"] ?? "application/json";
    hasBody = true;
  } else if (hasBody) {
    const body: Record<string, unknown> = {};
    for (const e of bodyEntries) body[e.key] = e.value;
    headers["content-type"] = headers["content-type"] ?? "application/json";
    init.body = JSON.stringify(body);
  }
  // Write gating: preview on dryRun (sends nothing); otherwise refuse unless MCP_ALLOW_WRITES=1.
  if (spec.write) {
    if (args.dryRun === true) {
      const preview = "DRY RUN - nothing was sent. This tool would send:\\n" + String(spec.method).toUpperCase() + " " + url + (hasBody ? "\\nbody: " + String(init.body) : "");
      return { content: [{ type: "text" as const, text: preview }], isError: false };
    }
    if (!HTTP_ALLOW_WRITES) {
      return { content: [{ type: "text" as const, text: WRITE_REFUSED_HINT }], isError: true };
    }
  }
  // Credentials (env) are merged LAST so they win over baked/templated headers, and only for our own origin.
  Object.assign(headers, envAuthHeaders(url));
  await assertPublicHttpUrl(url);
  const res = await fetchWithRetry(url, init);
  if (res.url) await assertPublicHttpUrl(res.url);
  const ctype = res.headers.get("content-type") ?? spec.headers["accept"] ?? (spec.json ? "application/json" : "");
  // Don't dump binary bytes at the model; report what it is and where instead.
  if (BINARY_CTYPE.test(ctype)) {
    const len = res.headers.get("content-length") || "unknown";
    try { await (res.body as any)?.cancel?.(); } catch { /* ignore */ }
    return { content: [{ type: "text" as const, text: "[binary response: " + ctype + ", " + len + " bytes] " + url + "\\nNot rendered as text." }], isError: !res.ok };
  }
  const raw = await readLimitedText(res, HTTP_MAX_RESPONSE_BYTES);
  const select = typeof args.select === "string" && args.select.trim() ? args.select.trim() : undefined;
  const text = shapeResponseBody(raw, ctype, select);
  return { content: [{ type: "text" as const, text }], isError: !res.ok };
}

// Accept both {param} and {{param}} - inference is not consistent about brace style.
const PLACEHOLDER = /\\{\\{?(\\w+)\\}\\}?/g;

function interpolate(template: string | undefined, args: Record<string, unknown>, encode = false): string {
  return String(template ?? "").replace(PLACEHOLDER, (_m, key) => {
    const value = args[key];
    const text = value == null ? "" : String(value);
    return encode ? encodeURIComponent(text) : text;
  });
}

function interpolateUrl(template: string | undefined, args: Record<string, unknown>, baseUrl: string): string {
  const rawTemplate = String(template ?? "");
  const direct = rawTemplate.match(/^\\s*\\{\\{?(\\w+)\\}\\}?\\s*$/);
  if (direct?.[1]) return String(args[direct[1]] ?? "");
  const raw = interpolate(rawTemplate, args, true);
  try {
    const url = new URL(raw, baseUrl);
    for (const [key, value] of Array.from(url.searchParams.entries())) {
      if (value === "") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

// A navigate template references a required path param that was not supplied (e.g. /page-{{page}}.html).
// Missing query params are omitted by interpolateUrl so optional filters can share one deterministic tool.
function templateMissingPathParam(template: string | undefined, args: Record<string, unknown>): boolean {
  const pathTemplate = String(template ?? "").split(/[?#]/, 1)[0] ?? "";
  const re = new RegExp(PLACEHOLDER.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathTemplate))) {
    const key = m[1];
    if (key && (args[key] == null || String(args[key]) === "")) return true;
  }
  return false;
}

async function importBrowserDriver(): Promise<any> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
  // MCP_BROWSER_DRIVER lets a user opt into a stealth-patched, drop-in Playwright (e.g. "patchright" or
  // "rebrowser-playwright") for max anti-bot evasion - tried first, then plain playwright. Zero extra
  // dependency by default: the strongest stealth here is a real Chrome channel + a persistent profile.
  const preferred = process.env.MCP_BROWSER_DRIVER;
  for (const mod of [preferred, "playwright"]) {
    if (!mod) continue;
    try { return await dynamicImport(mod); } catch { /* try the next driver */ }
  }
  throw new Error("browser tools require playwright (or set MCP_BROWSER_DRIVER to an installed driver)");
}

// Persistent browser session
// ONE lazily-created Chromium page, reused across EVERY browser tool call, so multi-step flows keep
// state: search -> open a result -> add to cart -> view cart -> checkout. Loads the user's own
// MCP_STORAGE_STATE when set, so actions run as whatever session the user is already signed into locally
// (this is how authenticated actions like add-to-cart work without the server ever handling credentials).
interface Browsing {
  runSteps(spec: BrowserToolSpec, args: Record<string, unknown>): Promise<unknown>;
  navigate(url: string): Promise<string>;
  snapshot(): Promise<string>;
  click(ref: string): Promise<string>;
  type(ref: string, text: string, submit?: boolean): Promise<string>;
  pressKey(key: string, ref?: string): Promise<string>;
  selectOption(ref: string, value: string): Promise<string>;
  back(): Promise<string>;
  read(): Promise<string>;
  extract(mode: string): Promise<unknown>;
  dismiss?(): Promise<string>;
  resume?(): Promise<unknown>;
  close?(): Promise<void>;
}

function refSelector(ref: string): string {
  return '[data-__mcp_ref="' + String(ref).replace(/[^a-zA-Z0-9_-]/g, "") + '"]';
}

const STALE_REF = " - the page likely changed. Call browser_snapshot to get current refs.";

async function settle(page: any): Promise<void> {
  try { await page.waitForLoadState("domcontentloaded", { timeout: 8000 }); } catch { /* SPA: no full nav */ }
  try { await page.waitForTimeout(350); } catch { /* ignore */ }
}

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(String(a));
    const right = new URL(String(b));
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return String(a || "") === String(b || "");
  }
}

${emitGateRuntime()}

${emitPopupRuntime()}

// Probe the live page and decide whether the automated session is blocked (sign-in wall / CAPTCHA). A text
// pass (title + visible text) short-circuits ONLY on a positive captcha-text hit; otherwise - i.e. on every
// normal navigation - it also probes the DOM for a password field and the challenge widgets (cheap in-page
// locator counts, no network), since a sign-in/challenge often has no give-away text.
async function classifyGateLive(page: any, requestedUrl?: string): Promise<{ kind: string; reason: string }> {
  let landedUrl = "", title = "", text = "";
  try { landedUrl = page.url(); } catch { /* ignore */ }
  try { title = await page.title(); } catch { /* ignore */ }
  try {
    const body = await page.evaluate(() => { const d = (globalThis as any).document; return d && d.body ? d.body.innerText : ""; });
    text = String(body || "").slice(0, 20000);
  } catch { /* ignore */ }
  const quick = classifyGate({ requestedUrl, landedUrl, title, text });
  if (quick.kind === "captcha") return quick;
  let hasPasswordField = false;
  try { hasPasswordField = (await page.locator("input[type=password]").count()) > 0; } catch { /* ignore */ }
  let hasChallengeFrame = false;
  for (const sel of CHALLENGE_FRAME_SELECTORS) {
    try { if ((await page.locator(sel).first().count()) > 0) { hasChallengeFrame = true; break; } } catch { /* ignore */ }
  }
  return classifyGate({ requestedUrl, landedUrl, title, text, hasPasswordField, hasChallengeFrame });
}

// The message handed back to the calling agent when a human must act; the agent relays it to its user.
function handoffMessage(kind: string, url: string, opened: boolean): string {
  const what = kind === "auth"
    ? "This page requires you to SIGN IN"
    : "This page is showing a HUMAN-VERIFICATION challenge (CAPTCHA / bot check)";
  const act = kind === "auth" ? "sign-in" : "challenge";
  const where = opened
    ? "A browser window has opened on this machine."
    : "Open the page in a visible browser (set MCP_BROWSER_HEADLESS=0 and retry, or run this server on a machine with a display).";
  return [
    "PAUSED - human action needed.",
    what + ": " + url,
    where + " Complete the " + act + " there, then call browser_resume to continue.",
    "The browser session is preserved - nothing was lost. Tip: set MCP_BROWSER_PROFILE=<dir> to stay signed in across runs.",
  ].join("\\n");
}

// A dedicated, non-default Chrome profile dir (NEVER the user's live profile - Chrome locks it while open).
// When set, the session uses a persistent context so a one-time sign-in / challenge solve sticks across
// restarts. Mutually exclusive with MCP_STORAGE_STATE (Playwright forbids both), so this branch ignores it.
const BROWSER_PROFILE = process.env.MCP_BROWSER_PROFILE || "";
// "on" (default): on a detected gate, pop a VISIBLE window and hand off to the human. "off": detect-only
// (legacy behavior - never pops a window, just returns the page snapshot).
const HANDOFF_MODE = (process.env.MCP_HANDOFF || "on").toLowerCase();

class PlaywrightBrowsing implements Browsing {
  private started?: Promise<{ browser: any; context: any; page: any }>;
  private stepExecutor?: StepExecutor;
  // Forced visible on the next (re)launch - set when a gate hands off to a human.
  private forceHeaded = false;
  // Whether the live session is currently a visible window.
  private headed = false;
  // The action paused on a gate; browser_resume re-runs it once the human is done.
  private pending?: { kind: string; run: () => Promise<unknown> };
  constructor(stepExecutor?: StepExecutor) { this.stepExecutor = stepExecutor; }

  private async ensure(): Promise<{ browser: any; context: any; page: any }> {
    if (!this.started) this.started = this.launch();
    return this.started;
  }

  // Launch (or relaunch) the ONE persistent session. Stealth defaults cost nothing: a real Chrome channel +
  // a persistent profile + the AutomationControlled flag off + navigator.webdriver stripped. With a profile
  // dir, login/clearance persists on disk; otherwise seedState carries cookies across an in-process relaunch.
  private async launch(seedState?: any): Promise<{ browser: any; context: any; page: any }> {
    const { chromium } = await importBrowserDriver();
    const headless = !this.forceHeaded && process.env.MCP_BROWSER_HEADLESS !== "0";
    const channel = process.env.MCP_BROWSER_CHANNEL || undefined;
    const args = ["--disable-blink-features=AutomationControlled"];
    // An explicit channel/path wins; otherwise fall back to Playwright's bundled Chromium.
    const executablePath = process.env.MCP_BROWSER_PATH || (channel ? undefined : chromium.executablePath());
    let browser: any, context: any;
    if (BROWSER_PROFILE) {
      context = await chromium.launchPersistentContext(BROWSER_PROFILE, { headless, channel, executablePath, args, chromiumSandbox: false, viewport: null });
      browser = context.browser();
    } else {
      browser = await chromium.launch({ headless, channel, executablePath, args, chromiumSandbox: false });
      context = await browser.newContext({ storageState: seedState ?? (process.env.MCP_STORAGE_STATE || undefined) });
    }
    this.headed = !headless;
    try { await context.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) { /* ignore */ } }); } catch { /* ignore */ }
    const existing = (context.pages && context.pages()) || [];
    const page = existing.length ? existing[0] : await context.newPage();
    page.setDefaultTimeout(20000);
    if (SITE_URL) { try { await page.goto(SITE_URL, { waitUntil: "domcontentloaded" }); } catch { /* first snapshot still works */ } }
    return { browser, context, page };
  }

  // Swap the live session to a VISIBLE window so a human can sign in / solve a challenge. The new context
  // BECOMES the session (every later tool call uses it). Cookies carry across (profile dir persists on disk;
  // otherwise seed from the old context's storageState), then re-navigate so the human lands on the gated page.
  private async ensureHeaded(gatedUrl?: string): Promise<void> {
    const cur = await this.ensure();
    if (this.headed) { try { await cur.page.bringToFront(); } catch { /* ignore */ } return; }
    let seed: any;
    if (!BROWSER_PROFILE) { try { seed = await cur.context.storageState(); } catch { /* ignore */ } }
    await this.close();
    this.forceHeaded = true;
    this.started = this.launch(seed);
    let next: { browser: any; context: any; page: any };
    try {
      next = await this.started;
    } catch (err) {
      // A headed relaunch can fail on a display-less host (the headless-server case). NEVER leave a rejected
      // promise cached in this.started - ensure() reuses it, so that would brick every later tool call in
      // this process. Reset so the next call rebuilds a normal headless session; rethrow so raiseHandoff
      // reports "couldn't open a window" (pending stays set -> the session is still recoverable).
      this.started = undefined;
      this.forceHeaded = false;
      throw err;
    }
    const target = gatedUrl || SITE_URL || "";
    if (target) { try { await next.page.goto(target, { waitUntil: "domcontentloaded" }); } catch { /* ignore */ } }
    try { await next.page.bringToFront(); } catch { /* ignore */ }
  }

  // Detect a gate on the current page (fail-soft: any probe error => "ok", never block a legitimate action).
  private async checkGate(requestedUrl?: string): Promise<{ kind: string; reason: string }> {
    try { return await classifyGateLive(await this.page(), requestedUrl); }
    catch { return { kind: "ok", reason: "" }; }
  }

  // Begin a human handoff: stash the action to resume, pop a visible window, return the instruction message.
  private async raiseHandoff(gate: { kind: string; reason: string }, gatedUrl: string, rerun: () => Promise<unknown>): Promise<string> {
    if (HANDOFF_MODE === "off") return snapshotText(await this.page());
    this.pending = { kind: gate.kind, run: rerun };
    let opened = false;
    try { await this.ensureHeaded(gatedUrl); opened = true; } catch { opened = false; }
    return handoffMessage(gate.kind, gatedUrl, opened);
  }

  // After resume, re-observe: if the gate cleared, return a fresh snapshot; if not, hand off again.
  private async observeAfterResume(): Promise<string> {
    const gate = await this.checkGate(undefined);
    if (gate.kind !== "ok") return this.raiseHandoff(gate, (await this.page()).url(), () => this.observeAfterResume());
    this.pending = undefined;
    return this.snapshot();
  }

  // Interaction primitives (click/type/...) end here: a fresh snapshot, unless the action revealed a gate.
  private async snapshotOrGate(): Promise<string> {
    const gate = await this.checkGate(undefined);
    if (gate.kind !== "ok") return this.raiseHandoff(gate, (await this.page()).url(), () => this.observeAfterResume());
    this.pending = undefined;
    return this.snapshot();
  }

  // browser_resume: the human finished in the popped window; re-run the paused action. Self-correcting -
  // if still blocked it simply re-pauses with a fresh message.
  async resume(): Promise<unknown> {
    if (!this.pending) return "Nothing is paused. The session isn't waiting on a sign-in or challenge; use browser_navigate or a tool to continue.";
    return this.pending.run();
  }

  private async page(): Promise<any> { return (await this.ensure()).page; }

  private async locate(ref: string): Promise<any | null> {
    const page = await this.page();
    const loc = page.locator(refSelector(ref)).first();
    if ((await loc.count()) === 0) return null;
    return loc;
  }

  async runSteps(spec: BrowserToolSpec, args: Record<string, unknown>): Promise<unknown> {
    if (this.stepExecutor) return this.stepExecutor(spec, args);
    const page = await this.page();
    let extracted: unknown;
    for (const step of spec.steps) {
      if (step.action === "navigate") {
        // Skip only missing path params (stay on current page) so /page-{{page}}.html does not become
        // /page-.html. Missing query params are treated as optional filters and removed.
        if (templateMissingPathParam(step.value, args)) continue;
        const targetUrl = interpolateUrl(step.value, args, SITE_URL || page.url());
        if (!sameUrl(targetUrl, page.url())) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        }
        continue;
      }
      if (step.action === "waitFor") {
        if (step.target?.selector) await page.locator(step.target.selector).first().waitFor({ state: "visible" });
        else await page.waitForTimeout(Number(step.value || 300));
        continue;
      }
      if (step.action === "fill") {
        if (!step.target?.selector) throw new Error("browser fill step requires a selector");
        await page.locator(step.target.selector).first().fill(interpolate(step.value, args));
        continue;
      }
      if (step.action === "selectOption") {
        if (!step.target?.selector) throw new Error("browser selectOption step requires a selector");
        const value = interpolate(step.value, args);
        const loc = page.locator(step.target.selector).first();
        try { await loc.selectOption(value); } catch { await loc.selectOption({ label: value }); }
        continue;
      }
      if (step.action === "click") {
        if (!step.target?.selector) throw new Error("browser click step requires a selector");
        await page.locator(step.target.selector).first().click();
        continue;
      }
      if (step.action === "pressKey") {
        const value = interpolate(step.value, args);
        if (!value) throw new Error("browser pressKey step requires a key");
        if (step.target?.selector) await page.locator(step.target.selector).first().focus();
        await page.keyboard.press(value);
        await settle(page);
        continue;
      }
      if (step.action === "extract") {
        // Honor the inference's explicit card selector (+ fallbacks) so listing extraction works on ANY
        // site, not just product-URL pages. Falls back to the heuristic when no selector was provided.
        const selectors = step.target?.selector
          ? [step.target.selector, ...(step.target.fallbackSelectors || [])]
          : undefined;
        extracted = await extractData(page, step.value || "", selectors);
      }
    }
    const gate = await this.checkGate(undefined);
    if (gate.kind !== "ok") return this.raiseHandoff(gate, page.url(), () => this.runSteps(spec, args));
    this.pending = undefined;
    if (extracted === undefined) {
      const privacy = await pagePrivacy(page);
      extracted = privacy.restricted ? formatPrivacyBlocked(privacy) : htmlToText(await page.content());
    }
    return extracted;
  }

  async navigate(url: string): Promise<string> {
    const page = await this.page();
    let target = url;
    try { target = /^https?:/i.test(url) ? url : new URL(url, SITE_URL || page.url()).toString(); } catch { /* use raw */ }
    if (!sameUrl(target, page.url())) {
      await page.goto(target, { waitUntil: "domcontentloaded" });
    }
    const gate = await this.checkGate(target);
    if (gate.kind !== "ok") return this.raiseHandoff(gate, target, () => this.navigate(url));
    this.pending = undefined;
    try { await this.runDismiss(); } catch { /* best-effort consent dismissal */ }
    return this.snapshot();
  }

  async snapshot(): Promise<string> { return snapshotText(await this.page()); }

  // Run the curated consent-dismissal script in the page (no throw). Shared by browser_dismiss + navigate.
  private async runDismiss(): Promise<unknown> {
    const page = await this.page();
    try { return await page.evaluate(DISMISS_SCRIPT); } catch { return null; }
  }

  async dismiss(): Promise<string> {
    await this.runDismiss();
    await settle(await this.page());
    return this.snapshot();
  }

  async click(ref: string): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    await loc.click();
    await settle(await this.page());
    return this.snapshotOrGate();
  }

  async type(ref: string, text: string, submit?: boolean): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    await loc.fill(text);
    if (submit) { await loc.press("Enter"); await settle(await this.page()); }
    return this.snapshotOrGate();
  }

  async pressKey(key: string, ref?: string): Promise<string> {
    const page = await this.page();
    if (ref) {
      const loc = await this.locate(ref);
      if (!loc) return "No element for ref " + ref + STALE_REF;
      await loc.focus();
    }
    await page.keyboard.press(key);
    await settle(page);
    return this.snapshotOrGate();
  }

  async selectOption(ref: string, value: string): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    try { await loc.selectOption(value); } catch { await loc.selectOption({ label: value }); }
    await settle(await this.page());
    return this.snapshotOrGate();
  }

  async back(): Promise<string> {
    const page = await this.page();
    try { await page.goBack({ waitUntil: "domcontentloaded" }); } catch { /* nothing to go back to */ }
    return this.snapshotOrGate();
  }

  async read(): Promise<string> {
    const page = await this.page();
    const privacy = await pagePrivacy(page);
    if (privacy.restricted) return formatPrivacyBlocked(privacy);
    return htmlToText(await page.content());
  }

  async extract(mode: string): Promise<unknown> {
    return extractData(await this.page(), "json:" + String(mode || "metadata").replace(/^json:/, ""));
  }

  // Release the Chromium process. Without this the launched browser is an open handle that keeps the
  // server (and any test harness) alive forever. Safe to call when never started, and idempotent.
  async close(): Promise<void> {
    if (!this.started) return;
    const started = this.started;
    this.started = undefined;
    try {
      const { context, browser } = await started;
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } catch {
      /* never launched / already gone */
    }
  }
}

${emitOpenCliBrowsingRuntime(name, input.dynamicBackend ?? "playwright")}

async function callBrowser(spec: BrowserToolSpec, args: Record<string, unknown>, browsing: Browsing) {
  try {
    const result = await browsing.runSteps(spec, args);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }], isError: false };
  } catch (err) {
    return { content: [{ type: "text" as const, text: String(err instanceof Error ? err.message : err) }], isError: true };
  }
}

async function guardBrowsing(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }], isError: false };
  } catch (err) {
    return { content: [{ type: "text" as const, text: String(err instanceof Error ? err.message : err) }], isError: true };
  }
}

// Run an in-page evaluate that tolerates a mid-flight navigation. On a real/SPA site the document can be
// swapped between "page settled" and "evaluate ran" ("Execution context was destroyed"); wait for the new
// document and retry once instead of surfacing a transient error to the model.
async function evalWithRetry(page: any, fn: any, arg?: any): Promise<any> {
  try { await page.waitForLoadState("domcontentloaded", { timeout: 8000 }); } catch { /* ignore */ }
  try {
    return await page.evaluate(fn, arg);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (!/context was destroyed|execution context/i.test(msg)) throw err;
    try { await page.waitForLoadState("domcontentloaded", { timeout: 8000 }); } catch { /* ignore */ }
    try { await page.waitForTimeout(300); } catch { /* ignore */ }
    return await page.evaluate(fn, arg);
  }
}

async function pagePrivacy(page: any): Promise<{ restricted: boolean; url: string; title: string; items: Array<{ kind: string; label: string; detail?: string }> }> {
  return evalWithRetry(page, () => {
    const doc = (globalThis as any).document;
    const loc = (globalThis as any).location;
    const clean = (v: any) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim();
    const pathRe =
      /(?:^|\\/|\\b)(checkout|payment|billing|shipping|order(?:s|[-_]?confirmation)?|cart|account|profile|settings|login|log[-_]?in|signin|sign[-_]?in|signup|sign[-_]?up|register|password|reset|auth|oauth|sso|session|wallet|address|invoice)(?:\\/|\\b|$)/i;
    const fieldRe =
      /(?:password|passcode|otp|2fa|mfa|token|secret|session|auth|cookie|csrf|card|cc-|credit|cvv|cvc|security[-_ ]?code|expiry|expiration|routing|iban|bank|ssn|sin|tax|address|phone|email)/i;
    const textRe =
      /(?:checkout|payment|billing|shipping address|card number|credit card|debit card|cvv|cvc|security code|expiration date|password|one[-_ ]?time code|verification code|social security|order confirmation|invoice)/i;
    const longDigits = /\\b(?:\\d[ -]?){12,19}\\b/;
    const items: Array<{ key: string; kind: string; label: string; detail?: string }> = [];
    const add = (kind: string, label: string, detail?: string) => {
      const key = kind + ":" + label + ":" + (detail || "");
      if (!items.some((item) => item.key === key)) items.push({ key, kind, label, detail });
    };
    if (pathRe.test(loc.href)) add("page", "Sensitive URL", "checkout/account/payment-style path");
    if (textRe.test(doc.title)) add("page", "Sensitive title", clean(doc.title).slice(0, 80));
    for (const form of Array.from(doc.forms || []) as any[]) {
      const fields = Array.from(form.elements || []) as any[];
      const formText = clean([form.action, form.getAttribute?.("name"), form.id, form.getAttribute?.("aria-label")].filter(Boolean).join(" "));
      if (pathRe.test(formText) || fieldRe.test(formText)) add("form", "Sensitive form", form.action || formText.slice(0, 80));
      for (const field of fields) {
        const fieldText = clean([field.getAttribute?.("name"), field.getAttribute?.("type"), field.getAttribute?.("autocomplete"), field.getAttribute?.("placeholder"), field.id].filter(Boolean).join(" "));
        if (fieldRe.test(fieldText)) add("field", "Sensitive field", fieldText.slice(0, 80));
      }
    }
    let bodyText = "";
    try { bodyText = clean(doc.body ? doc.body.innerText : "").slice(0, 4000); } catch { /* ignore */ }
    if (textRe.test(bodyText) || longDigits.test(bodyText)) add("text", "Sensitive page text", "payment/auth/order details detected");
    const publicItems = items.map(({ kind, label, detail }) => ({ kind, label, detail }));
    return { restricted: publicItems.some((item) => ["page", "form", "field", "text"].includes(item.kind)), url: loc.href, title: doc.title, items: publicItems };
  });
}

function formatPrivacyBlocked(data: { url?: string; title?: string; items?: Array<{ kind: string; label: string; detail?: string }> }): string {
  const rows = (data.items || [])
    .slice(0, 8)
    .map((item) => "- " + item.kind + ": " + item.label + (item.detail ? " (" + String(item.detail).slice(0, 90) + ")" : ""));
  return (
    "PRIVACY GUARD: Page content withheld locally before sending it to the agent.\\n" +
    "PAGE: " + (data.title || "(untitled)") + "\\nURL: " + (data.url || "") +
    "\\n\\nWITHHELD CONTEXT:\\n" + (rows.length ? rows.join("\\n") : "- page: sensitive flow detected") +
    "\\n\\nOnly navigation away from this page or user-confirmed actions should continue."
  );
}

// Compact, ref-annotated view of the live page: enumerated INTERACTIVE elements (each tagged in-page with
// data-__mcp_ref so browser_click/type/select can resolve it) + title/url + a visible-text excerpt.
async function snapshotText(page: any): Promise<string> {
  const privacy = await pagePrivacy(page);
  if (privacy.restricted) return formatPrivacyBlocked(privacy);
  const data = await evalWithRetry(page, () => {
    const doc = (globalThis as any).document;
    const loc = (globalThis as any).location;
    const win = globalThis as any;
    const clean = (v: any) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim();
    const selector =
      "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[onclick],[contenteditable=true]";
    const nodes = Array.from(doc.querySelectorAll(selector) as any[]);
    const elements: any[] = [];
    let i = 0;
    for (const el of nodes) {
      if (elements.length >= 120) break;
      let rect: any = { width: 1, height: 1 };
      try { rect = el.getBoundingClientRect(); } catch { /* detached */ }
      if (rect.width === 0 && rect.height === 0) continue;
      try {
        const style = win.getComputedStyle ? win.getComputedStyle(el) : null;
        if (style && (style.visibility === "hidden" || style.display === "none")) continue;
      } catch { /* ignore */ }
      const ref = "e" + ++i;
      try { el.setAttribute("data-__mcp_ref", ref); } catch { continue; }
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name = clean(
        el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.textContent || el.getAttribute("title") || el.getAttribute("name"),
      ).slice(0, 80);
      const type = el.getAttribute("type") || "";
      elements.push({ ref, role, name, type });
    }
    let text = "";
    try { text = clean(doc.body ? doc.body.innerText : "").slice(0, 1800); } catch { /* ignore */ }
    return { url: loc.href, title: doc.title, elements, text };
  });
  const lines = (data.elements as any[]).map(
    (e: any) => "[" + e.ref + "] " + e.role + (e.type ? " type=" + e.type : "") + (e.name ? ' "' + e.name + '"' : ""),
  );
  return (
    "PAGE: " + (data.title || "(untitled)") + "\\nURL: " + data.url +
    "\\n\\nINTERACTIVE ELEMENTS (pass a [ref] to browser_click / browser_type / browser_select_option):\\n" +
    (lines.length ? lines.join("\\n") : "(none found)") +
    "\\n\\nVISIBLE TEXT (excerpt):\\n" + data.text
  );
}

async function extractData(page: any, mode: string, selectors?: string[]): Promise<unknown> {
  const privacy = await pagePrivacy(page);
  if (privacy.restricted) return { privacyBlocked: true, url: privacy.url, title: privacy.title, withheld: privacy.items };
  if (mode === "json:metadata" || mode === "json:product" || mode === "json:listing" || mode === "json:linkedin_jobs") {
    return evalWithRetry(page, (params: { extractMode: string; selectors?: string[] }) => {
      const extractMode = params.extractMode;
      const cardSelectors = params.selectors || [];
      const doc = (globalThis as any).document;
      const loc = (globalThis as any).location;
      const clean = (value: string | null | undefined) => String(value || "").replace(/\\s+/g, " ").trim();
      const textOf = (selectors: string[]) => {
        for (const selector of selectors) {
          const node = doc.querySelector(selector);
          const text = clean(node?.textContent);
          if (text) return text;
        }
        return "";
      };
      const attrOf = (selectors: string[], attr: string) => {
        for (const selector of selectors) {
          const node = doc.querySelector(selector);
          const value = node?.getAttribute(attr);
          if (value) return value;
        }
        return "";
      };
      const jsonLd = Array.from(doc.querySelectorAll('script[type="application/ld+json"]') as any[])
        .slice(0, 12)
        .flatMap((node: any) => {
          try {
            const parsed = JSON.parse(node.textContent || "null");
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return [];
          }
        });
      const productLd = jsonLd.find((entry) => {
        const type = entry?.["@type"];
        return type === "Product" || (Array.isArray(type) && type.includes("Product"));
      });
      const listingCandidates = Array.from(doc.querySelectorAll("a[href]") as any[])
        .map((node: any) => ({ text: clean(node.textContent), href: node.href, node }))
        .filter((entry: any) => entry.text && /\\/(dp|products?|item|items|itm|sku|p)\\//i.test(entry.href));
      if (extractMode === "json:metadata") {
        return {
          title: doc.title,
          url: loc.href,
          description: attrOf(['meta[name="description"]', 'meta[property="og:description"]'], "content"),
          headings: Array.from(doc.querySelectorAll("h1,h2,h3") as any[]).slice(0, 12).map((node: any) => clean(node.textContent)).filter(Boolean),
          links: Array.from(doc.querySelectorAll("a[href]") as any[]).slice(0, 20).map((node: any) => ({ text: clean(node.textContent), url: node.href })).filter((entry: any) => entry.text),
        };
      }
      if (extractMode === "json:product") {
        const offer = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
        const availabilityText = clean(
          typeof offer?.availability === "string" ? offer.availability.split("/").pop() : textOf(["#availability", "[data-availability]", ".availability"]),
        );
        return {
          title: productLd?.name || textOf(["h1", "#title", "[data-testid='product-title']"]),
          sku: productLd?.sku || productLd?.productID || clean(loc.pathname.match(/\\/(?:dp|product|products|item|itm|sku|p)\\/([^/?#]+)/i)?.[1] || ""),
          price: offer?.price || textOf([".a-price .a-offscreen", "[itemprop='price']", "[data-testid='price']", ".price"]),
          currency: offer?.priceCurrency || attrOf(["[itemprop='priceCurrency']"], "content"),
          availability: availabilityText,
          rating: String(productLd?.aggregateRating?.ratingValue || textOf(["[data-testid='rating']", ".a-icon-alt", "[itemprop='ratingValue']"]) || ""),
          reviewCount: String(productLd?.aggregateRating?.reviewCount || textOf(["#acrCustomerReviewText", "[itemprop='reviewCount']"]) || ""),
          brand: productLd?.brand?.name || productLd?.brand || textOf(["[data-testid='brand']", "[itemprop='brand']"]),
          images: Array.isArray(productLd?.image) ? productLd.image.slice(0, 8) : productLd?.image ? [productLd.image] : [],
          url: loc.href,
        };
      }
      if (extractMode === "json:linkedin_jobs") {
        const pickText = (root: any, selectors: string[]) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector);
            const text = clean(node?.textContent);
            if (text) return text;
          }
          return "";
        };
        const jobIdFromUrl = (url: string) => {
          const match = String(url || "").match(/\\/jobs\\/view\\/(\\d+)/i) || String(url || "").match(/[?&]currentJobId=(\\d+)/i);
          return match ? match[1] : "";
        };
        const selected = {
          title: textOf([".jobs-unified-top-card__job-title", ".job-details-jobs-unified-top-card__job-title", "h1"]),
          company: textOf([".jobs-unified-top-card__company-name", ".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__subtitle-primary-grouping a"]),
          location: textOf([".jobs-unified-top-card__bullet", ".job-details-jobs-unified-top-card__primary-description-container", ".jobs-unified-top-card__primary-description-container"]),
          workplace: textOf([".jobs-unified-top-card__workplace-type", ".job-details-jobs-unified-top-card__job-insight"]),
          url: loc.href,
          jobId: jobIdFromUrl(loc.href),
          description: textOf(["#job-details", ".jobs-description", ".jobs-box__html-content", ".jobs-description-content__text"]).slice(0, 5000),
        };
        const cardSelectors = [
          "li[data-occludable-job-id]",
          ".jobs-search-results__list-item",
          ".job-card-container",
          "[data-job-id]",
          "li.scaffold-layout__list-item",
        ];
        const cards: any[] = [];
        for (const selector of cardSelectors) {
          for (const card of Array.from(doc.querySelectorAll(selector) as any[])) {
            if (!cards.includes(card)) cards.push(card);
          }
        }
        const seen = new Set<string>();
        const results = cards
          .map((card: any) => {
            const link = card.querySelector('a[href*="/jobs/view/"]');
            const url = link?.href || "";
            const text = clean(card.textContent);
            const jobId = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id") || jobIdFromUrl(url);
            return {
              jobId,
              title: pickText(card, [".job-card-list__title", ".job-card-container__link", ".job-card-job-posting-card-wrapper__title", 'a[href*="/jobs/view/"]']) || clean(link?.textContent),
              company: pickText(card, [".job-card-container__primary-description", ".artdeco-entity-lockup__subtitle", "[class*='company']"]),
              location: pickText(card, [".job-card-container__metadata-item", ".artdeco-entity-lockup__caption", "[class*='location']"]),
              url,
              text: text.slice(0, 700),
            };
          })
          .filter((entry: any) => {
            const key = entry.jobId || entry.url || entry.title + "|" + entry.company + "|" + entry.location;
            if (!entry.title && !entry.text) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 25);
        return {
          url: loc.href,
          query: {
            keywords: new URLSearchParams(loc.search).get("keywords") || "",
            location: new URLSearchParams(loc.search).get("location") || "",
            start: new URLSearchParams(loc.search).get("start") || "0",
          },
          selectedJob: selected.title || selected.company || selected.description ? selected : null,
          results,
        };
      }
      // Preferred path: the inference identified the repeated card selector (e.g. "div.quote", ".product").
      // Extract one record per matching card: works for quotes/articles/listings, not just product links.
      for (const sel of cardSelectors) {
        let cards: any[] = [];
        try { cards = Array.from(doc.querySelectorAll(sel) as any[]); } catch { cards = []; }
        if (cards.length) {
          const seenCards = new Set<string>();
          return cards
            .slice(0, 40)
            .map((card: any) => {
              const cardText = clean(card.textContent);
              const link = card.querySelector("a[href]");
              const heading = card.querySelector("h1,h2,h3,h4,h5,.title,[class*='title'],[itemprop='name']");
              const price = cardText.match(/(?:\\$|\\u00A3|\\u20AC|CAD\\s?)[\\d,.]+/)?.[0] || "";
              const rating = cardText.match(/\\b\\d(?:\\.\\d)?\\s*(?:out of 5|\\/5|stars?)\\b/i)?.[0] || "";
              return {
                title: clean(heading?.textContent) || (link ? clean(link.textContent) : "") || cardText.slice(0, 80),
                url: link ? link.href : loc.href,
                price,
                rating,
                text: cardText.slice(0, 500),
              };
            })
            .filter((entry: any) => {
              const key = entry.title + "|" + entry.text;
              if (!entry.title && !entry.text) return false;
              if (seenCards.has(key)) return false;
              seenCards.add(key);
              return true;
            })
            .slice(0, 24);
        }
      }
      const seen = new Set<string>();
      return listingCandidates
        .map((entry) => {
          const card = entry.node.closest("article,li,div");
          const cardText = clean(card?.textContent || "");
          const price = cardText.match(/(?:\\$|\\u00A3|\\u20AC|CAD\\s?)[\\d,.]+/)?.[0] || "";
          const rating = cardText.match(/\\b\\d(?:\\.\\d)?\\s*(?:out of 5|\\/5|stars?)\\b/i)?.[0] || "";
          return {
            title: entry.text,
            url: entry.href,
            price,
            rating,
          };
        })
        .filter((entry: any) => {
          if (seen.has(entry.url)) return false;
          seen.add(entry.url);
          return true;
        })
        .slice(0, 24);
    }, { extractMode: mode, selectors });
  }
  return htmlToText(await page.content());
}

const MAX_CONTENT = 40000;
function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\\s\\S]*?-->/g, " ")
    .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<head[\\s\\S]*?<\\/head>/gi, " ")
    .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, " ")
    .replace(/<svg[\\s\\S]*?<\\/svg>/gi, " ")
    .replace(/<\\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\\n")
    .replace(/<br\\s*\\/?>/gi, "\\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \\t]+/g, " ")
    .replace(/\\n\\s*\\n\\s*\\n+/g, "\\n\\n")
    .split("\\n").map((l) => l.trim()).join("\\n")
    .trim();
  return text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) + "\\n\\n...[truncated]" : text;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
// browsing: the persistent session (inject a fake in tests). browserExecutor: legacy hook to override only
// the steps-based shortcut tools (kept for back-compat); primitives always use the persistent session.
type CreateServerDeps = { browsing?: Browsing; browserExecutor?: StepExecutor };

export function createServer(deps: CreateServerDeps = {}): McpServer {
  const server = new McpServer({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(String(input.version))} });
  const browsing: Browsing = deps.browsing ?? createBrowsing(deps.browserExecutor);
  // Expose the session so the host can release Chromium on shutdown (and so tests can tear it down).
  (server as unknown as { browsing: Browsing }).browsing = browsing;

  // registerTool's full generic deep-instantiates over zod 4's types (TS2589). Bind it to a faithful,
  // simplified signature; the runtime method is identical, this only changes the static view.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description?: string; inputSchema?: z.ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => void;

${registrations}${toolkit ? "\n\n" + toolkit : ""}

  return server;
}

// Connect over stdio only when run directly (so tests can attach an in-memory transport instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  const browsing = (server as unknown as { browsing?: { close?: () => Promise<void> } }).browsing;
  let closing = false;
  const releaseBrowser = async () => {
    if (closing) return;
    closing = true;
    try { await browsing?.close?.(); } catch { /* ignore */ }
  };
  const shutdown = async () => {
    await releaseBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const transport = new StdioServerTransport();
  // Also release Chromium on a graceful stdio close (host disconnects stdin without a signal).
  transport.onclose = releaseBrowser;
  await server.connect(transport);
  setInterval(() => undefined, 2_147_483_647);
}
`;
}

export function configSnippet(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  return JSON.stringify(
    { mcpServers: { [name]: { type: "stdio", command: "node", args: [`/absolute/path/to/${name}/server.js`], env: {} } } },
    null,
    2,
  );
}

// Verified compatible ranges (see services/generator README). zod MUST be >=3.25 (MCP SDK requirement).
const MCP_SDK_RANGE = "^1.29.0";
const ZOD_RANGE = "^3.25.0 || ^4.0.0";
const TYPESCRIPT_RANGE = "^5.7.0";
const PLAYWRIGHT_RANGE = "^1.54.2";
// opencli is a real (declared) dependency for the advanced real-Chrome backend - pulled in only when this
// server defaults to it, so HTTP/Playwright servers stay lean. The bridge (extension + daemon) is set up once
// per machine (see docs/OPENCLI_BACKEND.md); the npm dep just provides the `opencli` CLI the server shells out to.
const OPENCLI_RANGE = "^1.8.0";

/** A standalone package.json so the artifact is installable + buildable on the user's machine. */
export function packageJson(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  const dependencies: Record<string, string> = {
    "@modelcontextprotocol/sdk": MCP_SDK_RANGE,
    zod: ZOD_RANGE,
    playwright: PLAYWRIGHT_RANGE,
  };
  if (input.dynamicBackend === "opencli") dependencies["@jackwener/opencli"] = OPENCLI_RANGE;
  return JSON.stringify(
    {
      name: `${name}-mcp-server`,
      version: "0.1.0",
      private: true,
      type: "module",
      bin: { [name]: "server.js" },
      scripts: { build: "tsc", start: "node server.js" },
      dependencies,
      devDependencies: { typescript: TYPESCRIPT_RANGE, "@types/node": "^22.0.0" },
    },
    null,
    2,
  );
}

/** tsconfig matching what `server.ts` needs: ESM/NodeNext, top-level await, emits server.js beside it. */
export function tsconfigJson(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["server.ts"],
    },
    null,
    2,
  );
}

/**
 * Shared JSON helper, emitted beside the install scripts. The default mode registers in Claude Code's
 * user MCP config (~/.claude.json), removes duplicate project-scoped entries for the same server, and
 * removes stale Claude Desktop entries. A legacy desktop mode is kept for users who explicitly opt in.
 */
export function registerHelperMjs(): string {
  // Built with string concatenation (no JS template literals) so codegen's own template literal below
  // doesn't try to interpolate the helper's ${...} expressions. Helper code uses SINGLE quotes throughout
  // so the surrounding double-quoted codegen strings need almost no escaping.
  return [
    `// Register this generated MCP server into EVERY detected MCP client, preserving existing entries.`,
    `// Like a normal MCP server install: it auto-detects each client's own config and writes the server there.`,
    `// Required env: MCP_REG_NAME, MCP_REG_NODE (node bin), MCP_REG_JS (server.js).`,
    `// Optional env: MCP_REG_MODE=desktop (legacy single-target Claude Desktop), MCP_REG_CONFIG (its path),`,
    `//   MCP_REG_CLAUDE_CODE_CONFIG (override ~/.claude.json), MCP_REG_CLEAN_CONFIGS (path-list of Claude`,
    `//   Desktop configs to de-dupe), MCP_REG_HOME (override home dir - for tests), MCP_REG_NO_CLI=1 (skip`,
    `//   the codex/code CLIs - for tests).`,
    `import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';`,
    `import { dirname, join } from 'node:path';`,
    `import { homedir, platform } from 'node:os';`,
    `import { spawnSync } from 'node:child_process';`,
    ``,
    `const name = process.env.MCP_REG_NAME;`,
    `const nodeBin = process.env.MCP_REG_NODE;`,
    `const serverJs = process.env.MCP_REG_JS;`,
    `if (!name || !nodeBin || !serverJs) {`,
    `  console.error('MCP_REG_NAME, MCP_REG_NODE, and MCP_REG_JS are required');`,
    `  process.exit(1);`,
    `}`,
    ``,
    `const HOME = process.env.MCP_REG_HOME || homedir();`,
    `const NO_CLI = process.env.MCP_REG_NO_CLI === '1';`,
    ``,
    `function readJson(file) {`,
    `  try { return JSON.parse(readFileSync(file, 'utf8') || '{}'); } catch { return {}; }`,
    `}`,
    `function ensureObject(value) {`,
    `  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};`,
    `}`,
    `function writeJson(file, cfg) {`,
    `  mkdirSync(dirname(file), { recursive: true });`,
    `  if (existsSync(file)) { try { copyFileSync(file, file + '.mcpbak'); } catch (e) { /* backup best-effort */ } }`,
    `  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\\n');`,
    `}`,
    ``,
    `// Full stdio entry (Claude Code / Cursor / Windsurf accept it; Claude Code needs the type+env).`,
    `function stdioEntry() { return { type: 'stdio', command: nodeBin, args: [serverJs], env: {} }; }`,
    `// VS Code's mcp.json omits env when empty.`,
    `function stdioEntryNoEnv() { return { type: 'stdio', command: nodeBin, args: [serverJs] }; }`,
    `// Claude Desktop's classic shape.`,
    `function desktopEntry() { return { command: nodeBin, args: [serverJs] }; }`,
    ``,
    `// VS Code keeps its user MCP config in a per-OS profile dir.`,
    `function vscodeUserDir() {`,
    `  if (platform() === 'darwin') return join(HOME, 'Library', 'Application Support', 'Code', 'User');`,
    `  if (platform() === 'win32') return join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Code', 'User');`,
    `  return join(HOME, '.config', 'Code', 'User');`,
    `}`,
    ``,
    `// Claude Desktop's config dir (per-OS). Linux has no official Desktop build; the path is provided so a`,
    `// custom/unofficial install is still detected if present.`,
    `function claudeDesktopDir() {`,
    `  if (platform() === 'darwin') return join(HOME, 'Library', 'Application Support', 'Claude');`,
    `  if (platform() === 'win32') return join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Claude');`,
    `  return join(HOME, '.config', 'Claude');`,
    `}`,
    ``,
    `// JSON-file clients. Registered only when DETECTED (config file or app dir present), except Claude Code`,
    `// which is always written (the flagship + this installer's historical default).`,
    `function jsonTargets() {`,
    `  const claudeCode = process.env.MCP_REG_CLAUDE_CODE_CONFIG || join(HOME, '.claude.json');`,
    `  const vsDir = vscodeUserDir();`,
    `  const desktopDir = claudeDesktopDir();`,
    `  return [`,
    `    { id: 'claude-code', label: 'Claude Code', file: claudeCode, key: 'mcpServers', entry: stdioEntry, force: true, projectCleanup: true },`,
    `    { id: 'claude-desktop', label: 'Claude Desktop', file: join(desktopDir, 'claude_desktop_config.json'), key: 'mcpServers', entry: desktopEntry, dirs: [desktopDir] },`,
    `    { id: 'cursor', label: 'Cursor', file: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers', entry: stdioEntry, dirs: [join(HOME, '.cursor')] },`,
    `    { id: 'windsurf', label: 'Windsurf', file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers', entry: stdioEntry, dirs: [join(HOME, '.codeium', 'windsurf'), join(HOME, '.codeium')] },`,
    `    { id: 'vscode', label: 'VS Code', file: join(vsDir, 'mcp.json'), key: 'servers', entry: stdioEntryNoEnv, dirs: [vsDir] },`,
    `  ];`,
    `}`,
    ``,
    `function isDetected(t) {`,
    `  if (t.force) return true;`,
    `  if (existsSync(t.file)) return true;`,
    `  return (t.dirs || []).some((d) => existsSync(d));`,
    `}`,
    ``,
    `function registerJsonTarget(t) {`,
    `  const cfg = ensureObject(readJson(t.file));`,
    `  cfg[t.key] = ensureObject(cfg[t.key]);`,
    `  cfg[t.key][name] = t.entry();`,
    `  let cleaned = 0;`,
    `  if (t.projectCleanup && cfg.projects && typeof cfg.projects === 'object') {`,
    `    for (const project of Object.values(cfg.projects)) {`,
    `      if (project && typeof project === 'object' && project.mcpServers && typeof project.mcpServers === 'object' && name in project.mcpServers) {`,
    `        delete project.mcpServers[name];`,
    `        cleaned++;`,
    `      }`,
    `    }`,
    `  }`,
    `  writeJson(t.file, cfg);`,
    `  console.log('Registered [' + name + '] into ' + t.label + ' (' + t.file + ')');`,
    `  if (cleaned) console.log('  - removed ' + cleaned + ' duplicate project-scoped entr' + (cleaned === 1 ? 'y' : 'ies') + '.');`,
    `}`,
    ``,
    `// Codex stores MCP servers in TOML (~/.codex/config.toml); use its official CLI rather than hand-editing`,
    `// TOML (no parser shipped, and a bad merge would corrupt the user's config). Idempotent: remove then add.`,
    `function registerCodexCli() {`,
    `  if (NO_CLI) return;`,
    `  const removed = spawnSync('codex', ['mcp', 'remove', name], { encoding: 'utf8' });`,
    `  if (removed.error && removed.status !== 0) return; // codex not on PATH / not runnable`,
    `  const res = spawnSync('codex', ['mcp', 'add', name, '--', nodeBin, serverJs], { encoding: 'utf8' });`,
    `  if (res.status === 0 || (res.error && res.error.code === 'EPERM')) console.log('Registered [' + name + '] into Codex (codex mcp add).');`,
    `  else console.error('WARN: codex is installed but \\'codex mcp add\\' failed: ' + ((res.stderr || res.stdout || '').toString().trim() || ('exit ' + res.status)));`,
    `}`,
    ``,
    `function registerClaudeDesktop() {`,
    `  const configPath = process.env.MCP_REG_CONFIG;`,
    `  if (!configPath) { console.error('MCP_REG_CONFIG not set'); process.exit(1); }`,
    `  const cfg = ensureObject(readJson(configPath));`,
    `  cfg.mcpServers = ensureObject(cfg.mcpServers);`,
    `  cfg.mcpServers[name] = { command: nodeBin, args: [serverJs] };`,
    `  writeJson(configPath, cfg);`,
    `  console.log('Registered [' + name + '] into Claude Desktop (' + configPath + ')');`,
    `}`,
    ``,
    `function registerAll() {`,
    `  let wrote = 0;`,
    `  const skipped = [];`,
    `  for (const t of jsonTargets()) {`,
    `    if (isDetected(t)) { registerJsonTarget(t); wrote++; }`,
    `    else skipped.push(t.label);`,
    `  }`,
    `  registerCodexCli();`,
    `  if (skipped.length) console.log('Not detected (skipped): ' + skipped.join(', ') + '. Re-run install after installing them.');`,
    `  if (!wrote) console.error('WARN: no JSON MCP clients detected; nothing was written.');`,
    `}`,
    ``,
    `if (process.env.MCP_REG_MODE === 'desktop') registerClaudeDesktop();`,
    `else registerAll();`,
    ``,
  ].join("\n");
}

/**
 * POSIX installer (macOS/Linux). Run with `bash install.sh`. Installs deps, builds server.js, then
 * registers the server into every detected MCP client (Claude Code, Cursor, Windsurf, VS Code, Codex) so it
 * is usable from each, the way any MCP server install works. `MCP_TARGET=desktop`
 * keeps the legacy Claude Desktop behavior; `--no-register` builds only and prints the snippet.
 */
export function installSh(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  // Browser servers need Playwright's Chromium binary (npm install only fetches the library). Best-effort so
  // a failed download (offline/sandboxed) never aborts the install + registration of the HTTP tools.
  const playwrightStep = emitsBrowserToolkit(input)
    ? `echo "==> Installing Playwright's Chromium (needed by the browser_* tools) ..."
npx --yes playwright install chromium || echo "WARN: 'npx playwright install chromium' failed - browser_* tools will not work until you run it manually (add --with-deps on Linux if system libraries are missing)." >&2
`
    : "";
  return `#!/usr/bin/env bash
# install.sh - build this generated MCP server and register it into every detected MCP client.
#   bash install.sh                 install deps, build, and register into all detected clients
#   bash install.sh --no-register   build only, print the config snippet
#   MCP_TARGET=desktop bash install.sh   register only into the legacy Claude Desktop config
# Detected automatically: Claude Code (~/.claude.json), Cursor, Windsurf, VS Code, and Codex (via its CLI).
set -eo pipefail

SERVER_NAME="${name}"
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || { echo "ERROR: node (>=20) is required" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm is required" >&2; exit 1; }

# Absolute node path - MCP clients do not always inherit your shell PATH.
NODE_BIN="$(command -v node)"
SERVER_JS="$SCRIPT_DIR/server.js"

echo "==> Installing dependencies (npm install) ..."
npm install
echo "==> Building (npm run build) ..."
npm run build
${playwrightStep}
REGISTER=1
for arg in "$@"; do
  [ "$arg" = "--no-register" ] && REGISTER=0
done

TARGET="\${MCP_TARGET:-claude-code}"
for arg in "$@"; do
  [ "$arg" = "--desktop" ] && TARGET="desktop"
  [ "$arg" = "--claude-desktop" ] && TARGET="desktop"
  [ "$arg" = "--claude-code" ] && TARGET="claude-code"
done

if [ "$REGISTER" = "0" ]; then
  echo "Build complete. Add this to Claude Code user MCPs under \\"mcpServers\\":"
  echo "  \\"$SERVER_NAME\\": { \\"type\\": \\"stdio\\", \\"command\\": \\"$NODE_BIN\\", \\"args\\": [\\"$SERVER_JS\\"], \\"env\\": {} }"
  exit 0
fi

if [ "$TARGET" = "desktop" ]; then
  if [ -n "$MCP_CONFIG_PATH" ]; then
    CONFIG_PATH="$MCP_CONFIG_PATH"
  elif [ "$(uname)" = "Darwin" ]; then
    CONFIG_PATH="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  else
    CONFIG_PATH="$HOME/.config/Claude/claude_desktop_config.json"
  fi
  MCP_REG_MODE="desktop" MCP_REG_CONFIG="$CONFIG_PATH" MCP_REG_NAME="$SERVER_NAME" MCP_REG_NODE="$NODE_BIN" MCP_REG_JS="$SERVER_JS" \\
    node "$SCRIPT_DIR/mcp-register.mjs"
  echo "==> Done. Restart Claude Desktop to load \\"$SERVER_NAME\\"."
  exit 0
fi

# Multi-client: the helper auto-detects every installed client (Claude Code, Claude Desktop, Cursor,
# Windsurf, VS Code, Codex) from $HOME and registers into each in its own format.
MCP_REG_CLAUDE_CODE_CONFIG="\${CLAUDE_CODE_CONFIG:-$HOME/.claude.json}" \\
MCP_REG_NAME="$SERVER_NAME" MCP_REG_NODE="$NODE_BIN" MCP_REG_JS="$SERVER_JS" \\
  node "$SCRIPT_DIR/mcp-register.mjs"

echo "==> Done. Registered into every detected MCP client above. Restart the client (Claude Code: run /mcp) to load \\"$SERVER_NAME\\"."
`;
}

/**
 * Windows installer (PowerShell). Run with `powershell -ExecutionPolicy Bypass -File install.ps1`.
 * Same behavior as install.sh; targets Claude Code user MCPs by default.
 */
export function installPs1(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  // Browser servers need Playwright's Chromium binary; best-effort (warn, don't abort) like install.sh.
  const playwrightStep = emitsBrowserToolkit(input)
    ? `Write-Host "==> Installing Playwright's Chromium (needed by the browser_* tools) ..."
npx --yes playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Warning "playwright install chromium failed - browser_* tools will not work until you run it manually." }
`
    : "";
  return `# install.ps1 - build this generated MCP server and register it into every detected MCP client.
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 --no-register   (build only)
#   $env:MCP_TARGET = "desktop"   (opt into legacy Claude Desktop registration)
$ErrorActionPreference = "Stop"

$ServerName = "${name}"
$ScriptDir = $PSScriptRoot
Set-Location $ScriptDir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node (>=20) is required"; exit 1 }
$NodeBin = $node.Source
$ServerJs = Join-Path $ScriptDir "server.js"

Write-Host "==> Installing dependencies (npm install) ..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }
Write-Host "==> Building (npm run build) ..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed"; exit 1 }
${playwrightStep}
if ($args -contains "--no-register") {
  Write-Host "Build complete. Register manually in Claude Code user MCPs: command=$NodeBin args=$ServerJs"
  exit 0
}

$Target = if ($env:MCP_TARGET) { $env:MCP_TARGET } else { "claude-code" }
if ($args -contains "--desktop" -or $args -contains "--claude-desktop") { $Target = "desktop" }
if ($args -contains "--claude-code") { $Target = "claude-code" }

if ($Target -eq "desktop") {
  if ($env:MCP_CONFIG_PATH) {
    $ConfigPath = $env:MCP_CONFIG_PATH
  } else {
    $ConfigPath = Join-Path $env:APPDATA "Claude\\claude_desktop_config.json"
  }

  $env:MCP_REG_MODE = "desktop"
  $env:MCP_REG_CONFIG = $ConfigPath
  $env:MCP_REG_NAME = $ServerName
  $env:MCP_REG_NODE = $NodeBin
  $env:MCP_REG_JS = $ServerJs
  node (Join-Path $ScriptDir "mcp-register.mjs")
  if ($LASTEXITCODE -ne 0) { Write-Error "registration failed"; exit 1 }

  Write-Host "==> Done. Restart Claude Desktop to load $ServerName."
  exit 0
}

if ($env:CLAUDE_CODE_CONFIG) {
  $ClaudeCodeConfig = $env:CLAUDE_CODE_CONFIG
} else {
  $ClaudeCodeConfig = Join-Path $HOME ".claude.json"
}

# Multi-client: the helper auto-detects every installed client (Claude Code, Claude Desktop, Cursor,
# Windsurf, VS Code, Codex) and registers into each in its own format.
$env:MCP_REG_MODE = "claude-code-user"
$env:MCP_REG_CLAUDE_CODE_CONFIG = $ClaudeCodeConfig
$env:MCP_REG_NAME = $ServerName
$env:MCP_REG_NODE = $NodeBin
$env:MCP_REG_JS = $ServerJs
node (Join-Path $ScriptDir "mcp-register.mjs")
if ($LASTEXITCODE -ne 0) { Write-Error "registration failed"; exit 1 }

Write-Host "==> Done. Registered into every detected MCP client above. Restart the client (Claude Code: run /mcp) to load $ServerName."
`;
}

export function generateServer(input: CodegenInput): GeneratedServerArtifact {
  const snippet = configSnippet(input);
  const serverOrigin = (() => {
    try { return new URL(input.url).origin; } catch { return input.url; }
  })();
  const readme = `# ${commentSafe(input.title)} - MCP server\n\nAuto-generated from ${commentSafe(input.url)} (v${input.version}). Runs locally and may use public HTTP calls plus Playwright-driven browser steps.\n\n## Install (one step)\n\nThis builds the server and registers it into **every MCP client it detects on your machine**, then restart that client (in Claude Code, run \`/mcp\`).\n\n\`\`\`bash\n# macOS / Linux\nbash install.sh\n\`\`\`\n\`\`\`powershell\n# Windows\npowershell -ExecutionPolicy Bypass -File install.ps1\n\`\`\`\n\nThe installer auto-detects and registers into each client in its own config format, with an absolute \`node\` path, preserving your existing servers (and backing up each file it edits):\n\n- **Claude Code** - \`~/.claude.json\` (also de-dupes duplicate project-scoped entries)\n- **Claude Desktop** - the OS \`claude_desktop_config.json\`\n- **Cursor** - \`~/.cursor/mcp.json\`\n- **Windsurf** - \`~/.codeium/windsurf/mcp_config.json\`\n- **VS Code** - the user \`mcp.json\` (\`servers\` key)\n- **Codex** - via \`codex mcp add\` (its config is TOML)\n\nA client is registered only when it is detected (its config or app dir exists; Claude Code is always written). Re-run the installer after installing a new client. Pass \`--no-register\` to build only, or \`MCP_TARGET=desktop\` to target only the legacy Claude Desktop config.\n\n## Run manually\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm start\n\`\`\`\n\nBrowser tools use Playwright, and \`install.sh\`/\`install.ps1\` download the Chromium binary for you when this server has \`browser_*\` tools. To do it by hand instead: \`npx playwright install chromium\` (add \`--with-deps\` on Linux if system libraries are missing). Set \`MCP_BROWSER_PATH\` or \`MCP_BROWSER_CHANNEL=chrome\` to drive your own Chrome rather than the bundled Chromium.\n\n## Authenticated HTTP APIs (private endpoints, your API key)\n\nThe HTTP tools call **public** endpoints by default. To act as *you* against an authenticated API, set credentials in this server's \`env\`. They are attached ONLY to requests to this server's own origin (${commentSafe(serverOrigin)}) and never sent anywhere else (cross-origin or through a redirect):\n\n- \`MCP_AUTH_BEARER=<token>\` -> \`Authorization: Bearer <token>\`\n- \`MCP_API_KEY=<key>\` (+ optional \`MCP_API_KEY_HEADER\`, default \`x-api-key\`)\n- \`MCP_AUTH_COOKIE=<cookie>\` -> \`Cookie: <cookie>\` (paste a logged-in session cookie)\n- \`MCP_AUTH_HEADER="X-Custom: value"\` -> any header(s), one per line\n- \`MCP_AUTH_QUERY="api_key=..."\` -> appended as a query parameter\n\n## Write actions (create / update / delete)\n\nTools that can MODIFY data (PUT/PATCH/DELETE, or a POST that reads as a mutation) are **disabled by default** so an agent can't change things unexpectedly. Set \`MCP_ALLOW_WRITES=1\` to enable them, or call any such tool with \`dryRun: true\` to see the exact request without sending it. Read tools are unaffected.\n\n## Output & resilience\n\nJSON responses are pretty-printed; pass \`select\` (e.g. \`"id,name,owner.login"\`) to a read tool to project just those fields. HTML comes back as readable text; binary responses are summarized, not dumped. Idempotent (GET/HEAD) calls retry with backoff on \`429\`/\`5xx\` (honoring \`Retry-After\`). Tune with \`MCP_HTTP_TIMEOUT_MS\`, \`MCP_HTTP_MAX_RESPONSE_BYTES\`, \`MCP_HTTP_MAX_RETRIES\`.\n\n## Signed-in & bot-protected pages (stealth + human handoff)\n\nThe browser session runs with light stealth (real Chrome flags, \`navigator.webdriver\` stripped). When a tool hits a sign-in wall or a CAPTCHA it does NOT fail - it returns \`PAUSED - human action needed\`, opens a visible browser window, and waits. Complete the sign-in/challenge in that window, then call \`browser_resume\` to continue.\n\n- \`MCP_BROWSER_PROFILE=<dir>\`: a dedicated Chrome profile dir so a one-time sign-in/clearance STICKS across restarts (recommended; never point at your live Chrome profile).\n- \`MCP_BROWSER_HEADLESS=0\`: stay headed the whole time (best for multi-step authenticated flows).\n- \`MCP_BROWSER_CHANNEL=chrome\`: drive your real installed Chrome instead of bundled Chromium (stronger stealth).\n- \`MCP_BROWSER_DRIVER=patchright\`: opt into a stealth-patched Playwright drop-in (install it yourself) for hard bot walls.\n- \`MCP_HANDOFF=off\`: disable the popup/handoff (detect-only).\n\n## Real logged-in Chrome backend (opencli) - for dynamic / bot-walled sites\n\nHeadless Chromium gets blocked, or sees only an empty JS shell, on SPA / anti-bot sites (e.g. flight search). Set \`MCP_BROWSER_BACKEND=opencli\` to route the \`browser_*\` tools through [opencli](https://github.com/jackwener/opencli), which drives YOUR real, logged-in Chrome via its Browser Bridge - the page renders fully, anti-bot does not fire, and you stay signed in. One-time setup: \`npm i -g @jackwener/opencli\`, add the Browser Bridge extension from the Chrome Web Store, then \`opencli doctor\` to confirm the bridge. Servers generated from sites detected as dynamic default to this backend. See \`docs/OPENCLI_BACKEND.md\`.\n\nThe \`claude_code_config.json\` snippet is also included if you prefer to wire it up by hand (fix the absolute path).\n`;
  return {
    serverId: input.serverId,
    version: input.version,
    files: [
      { path: "server.ts", content: generateServerSource(input) },
      { path: "package.json", content: packageJson(input) },
      { path: "tsconfig.json", content: tsconfigJson() },
      { path: "claude_code_config.json", content: snippet },
      { path: "mcp-register.mjs", content: registerHelperMjs() },
      { path: "install.sh", content: installSh(input) },
      { path: "install.ps1", content: installPs1(input) },
      { path: "README.md", content: readme },
    ],
    entrypoint: "server.ts",
    configSnippet: snippet,
    // Carried so a client can Apply + use the tools directly (the toolkit primitives are NOT here, they're
    // emitted into server.ts only; these are the inferred site tools, e.g. search_products/get_product_page).
    tools: input.tools,
  };
}
