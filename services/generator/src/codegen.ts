import type { ToolDefinition, GeneratedServerArtifact } from "@mcp/types";

/**
 * Codegen: ToolDefinition[] -> a runnable MCP server artifact (`01 S3`, `services/generator.md`).
 * Emits `server.ts` against the verified @modelcontextprotocol/sdk API (McpServer.registerTool +
 * StdioServerTransport), a claude_desktop_config.json snippet, and a README. Deterministic.
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
    return new URL(rawUrl).origin + urlPattern;
  } catch {
    return urlPattern;
  }
}

function toolRegistration(tool: ToolDefinition): string {
  const shape = zodRawShapeSource(tool.inputSchema);
  if (tool.execution.kind === "http") {
    const req = tool.execution.request;
    const spec = {
      method: req.method,
      urlTemplate: urlTemplate(req.rawUrl, req.urlPattern),
      headers: req.requestHeaders,
      paramMapping: tool.execution.paramMapping,
    };
    return `  register(
    ${JSON.stringify(tool.name)},
    { description: ${JSON.stringify(tool.description)}, inputSchema: ${shape} },
    async (args) => callHttp(${JSON.stringify(spec)}, args),
  );`;
  }
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
] as const;

/**
 * The fixed browsing toolkit (NOT inferred tools - emitted directly so the frozen `01 S2` ExecutionStrategy
 * union stays untouched). Registered against the same persistent `browsing` session the shortcut tools use,
 * so the model can compose: snapshot -> click(ref) -> snapshot -> ... across many tool calls.
 */
function browsingToolkitRegistrations(input: CodegenInput): string {
  const emit = input.browsing ?? input.tools.some((t) => t.execution.kind === "browser");
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
        "Extract structured JSON from the current page. mode = 'product' (price/availability/rating/...), 'listing' (search-result cards), or 'metadata' (title/headings/links, the default).",
      shape: "{ mode: z.string().optional() }",
      call: 'browsing.extract(String(args.mode || "metadata"))',
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

export function generateServerSource(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  const registrations = input.tools.map(toolRegistration).join("\n\n");
  const toolkit = browsingToolkitRegistrations(input);
  return `// AUTO-GENERATED MCP server for ${input.url}
// serverId=${input.serverId} version=${input.version}. Generated by @mcp/generator.
// Runs LOCALLY on your machine. Do not commit secrets; this server calls only public endpoints (v1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";

type HttpToolSpec = {
  method: string;
  urlTemplate: string;
  headers: Record<string, string>;
  paramMapping: Record<string, { in: "path" | "query" | "header" | "body"; key: string }>;
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
const SITE_URL = ${JSON.stringify(input.url)};

async function callHttp(spec: HttpToolSpec, args: Record<string, unknown>) {
  let url = spec.urlTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { ...spec.headers };
  const body: Record<string, unknown> = {};
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
    else { body[m.key] = value; hasBody = true; }
  }
  const qs = query.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  const init: RequestInit = { method: spec.method, headers };
  if (hasBody) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  const ctype = res.headers.get("content-type") ?? spec.headers["accept"] ?? "";
  // HTML responses are dumped to the model as READABLE TEXT, not raw markup (a docs/content page is
  // mostly tags otherwise). JSON and other types pass through unchanged.
  const text = /html/i.test(ctype) ? htmlToText(raw) : raw;
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

// A navigate template references a param that was not supplied (e.g. paginated tool called with no page).
function templateMissingParam(template: string | undefined, args: Record<string, unknown>): boolean {
  const re = new RegExp(PLACEHOLDER.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(template ?? "")))) {
    const key = m[1];
    if (key && (args[key] == null || String(args[key]) === "")) return true;
  }
  return false;
}

async function importBrowserDriver(): Promise<any> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
  try {
    return await dynamicImport("playwright");
  } catch {
    throw new Error("browser tools require the generated server's playwright dependency");
  }
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

class PlaywrightBrowsing implements Browsing {
  private started?: Promise<{ browser: any; context: any; page: any }>;
  private stepExecutor?: StepExecutor;
  constructor(stepExecutor?: StepExecutor) { this.stepExecutor = stepExecutor; }

  private async ensure(): Promise<{ browser: any; context: any; page: any }> {
    if (!this.started) {
      this.started = (async () => {
        const { chromium } = await importBrowserDriver();
        const browser = await chromium.launch({
          headless: process.env.MCP_BROWSER_HEADLESS === "0" ? false : true,
          chromiumSandbox: false,
          channel: process.env.MCP_BROWSER_CHANNEL || undefined,
          executablePath: process.env.MCP_BROWSER_PATH || chromium.executablePath(),
        });
        const context = await browser.newContext({ storageState: process.env.MCP_STORAGE_STATE || undefined });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        if (SITE_URL) { try { await page.goto(SITE_URL, { waitUntil: "domcontentloaded" }); } catch { /* first snapshot still works */ } }
        return { browser, context, page };
      })();
    }
    return this.started;
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
        // Skip a navigate whose params were not supplied (stay on the current page) so a paginated tool
        // called without e.g. page extracts the current listing instead of a 404 URL like /page-.html.
        // Tradeoff: if the inputSchema param and the URL placeholder are named differently, a supplied arg
        // looks "missing" here and we silently stay put instead of erroring. The base navigate (when present)
        // still lands on the right listing, so this favors a useful result over a loud failure.
        if (templateMissingParam(step.value, args)) continue;
        await page.goto(interpolate(step.value, args, true), { waitUntil: "domcontentloaded" });
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
    if (extracted === undefined) extracted = htmlToText(await page.content());
    return extracted;
  }

  async navigate(url: string): Promise<string> {
    const page = await this.page();
    let target = url;
    try { target = /^https?:/i.test(url) ? url : new URL(url, SITE_URL || page.url()).toString(); } catch { /* use raw */ }
    await page.goto(target, { waitUntil: "domcontentloaded" });
    return this.snapshot();
  }

  async snapshot(): Promise<string> { return snapshotText(await this.page()); }

  async click(ref: string): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    await loc.click();
    await settle(await this.page());
    return this.snapshot();
  }

  async type(ref: string, text: string, submit?: boolean): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    await loc.fill(text);
    if (submit) { await loc.press("Enter"); await settle(await this.page()); }
    return this.snapshot();
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
    return this.snapshot();
  }

  async selectOption(ref: string, value: string): Promise<string> {
    const loc = await this.locate(ref);
    if (!loc) return "No element for ref " + ref + STALE_REF;
    try { await loc.selectOption(value); } catch { await loc.selectOption({ label: value }); }
    await settle(await this.page());
    return this.snapshot();
  }

  async back(): Promise<string> {
    const page = await this.page();
    try { await page.goBack({ waitUntil: "domcontentloaded" }); } catch { /* nothing to go back to */ }
    return this.snapshot();
  }

  async read(): Promise<string> { return htmlToText(await (await this.page()).content()); }

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

// Compact, ref-annotated view of the live page: enumerated INTERACTIVE elements (each tagged in-page with
// data-__mcp_ref so browser_click/type/select can resolve it) + title/url + a visible-text excerpt.
async function snapshotText(page: any): Promise<string> {
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
  if (mode === "json:metadata" || mode === "json:product" || mode === "json:listing") {
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
  const browsing: Browsing = deps.browsing ?? new PlaywrightBrowsing(deps.browserExecutor);
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
}
`;
}

export function configSnippet(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  return JSON.stringify(
    { mcpServers: { [name]: { command: "node", args: [`/absolute/path/to/${name}/server.js`] } } },
    null,
    2,
  );
}

// Verified compatible ranges (see services/generator README). zod MUST be >=3.25 (MCP SDK requirement).
const MCP_SDK_RANGE = "^1.29.0";
const ZOD_RANGE = "^3.25.0 || ^4.0.0";
const TYPESCRIPT_RANGE = "^5.7.0";
const PLAYWRIGHT_RANGE = "^1.54.2";

/** A standalone package.json so the artifact is installable + buildable on the user's machine. */
export function packageJson(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  return JSON.stringify(
    {
      name: `${name}-mcp-server`,
      version: "0.1.0",
      private: true,
      type: "module",
      bin: { [name]: "server.js" },
      scripts: { build: "tsc", start: "node server.js" },
      dependencies: { "@modelcontextprotocol/sdk": MCP_SDK_RANGE, zod: ZOD_RANGE, playwright: PLAYWRIGHT_RANGE },
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
 * Shared JSON-merge helper, emitted beside the install scripts. Both install.sh and install.ps1 just set
 * env vars and run `node mcp-register.mjs`, keeping the actual config merge in one place (Node, which is
 * already required to run the server) instead of duplicating brittle jq/PowerShell JSON surgery.
 * It is idempotent and PRESERVES any existing mcpServers entries; it creates the config file + parent dir.
 */
export function registerHelperMjs(): string {
  // Built with string concatenation (no JS template literals) so codegen's own template literal below
  // doesn't try to interpolate the helper's ${...} expressions.
  return [
    `// Merge this server into an MCP client config (Claude Desktop), preserving existing entries.`,
    `// Driven by env: MCP_REG_CONFIG (config path), MCP_REG_NAME, MCP_REG_NODE (node bin), MCP_REG_JS (server.js).`,
    `import { readFileSync, writeFileSync, mkdirSync } from "node:fs";`,
    `import { dirname } from "node:path";`,
    ``,
    `const path = process.env.MCP_REG_CONFIG;`,
    `if (!path) { console.error("MCP_REG_CONFIG not set"); process.exit(1); }`,
    ``,
    `let cfg = {};`,
    `try { cfg = JSON.parse(readFileSync(path, "utf8") || "{}"); } catch { cfg = {}; }`,
    `if (!cfg || typeof cfg !== "object") cfg = {};`,
    `if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};`,
    ``,
    `cfg.mcpServers[process.env.MCP_REG_NAME] = {`,
    `  command: process.env.MCP_REG_NODE,`,
    `  args: [process.env.MCP_REG_JS],`,
    `};`,
    ``,
    `mkdirSync(dirname(path), { recursive: true });`,
    `writeFileSync(path, JSON.stringify(cfg, null, 2) + "\\n");`,
    `console.log("Registered \\"" + process.env.MCP_REG_NAME + "\\" in " + path);`,
    ``,
  ].join("\n");
}

/**
 * POSIX installer (macOS/Linux). Run with `bash install.sh`. Installs deps, builds server.js, then
 * registers the server in the Claude Desktop config so the client launches it over stdio by absolute path.
 * Honors MCP_CONFIG_PATH to target a different client/config; `--no-register` builds only and prints the snippet.
 * Resolves an ABSOLUTE node path at install time (GUI-launched clients don't inherit your shell PATH).
 */
export function installSh(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  return `#!/usr/bin/env bash
# install.sh - build this generated MCP server and register it with your MCP client (Claude Desktop).
#   bash install.sh                 install deps, build, and register
#   bash install.sh --no-register   build only, print the config snippet
#   MCP_CONFIG_PATH=/path/to/config.json bash install.sh   target a specific client config
set -eo pipefail

SERVER_NAME="${name}"
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || { echo "ERROR: node (>=20) is required" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm is required" >&2; exit 1; }

# Absolute node path - GUI-launched Claude Desktop often does not inherit your shell PATH.
NODE_BIN="$(command -v node)"
SERVER_JS="$SCRIPT_DIR/server.js"

echo "==> Installing dependencies (npm install) ..."
npm install
echo "==> Building (npm run build) ..."
npm run build

REGISTER=1
for arg in "$@"; do
  [ "$arg" = "--no-register" ] && REGISTER=0
done

if [ "$REGISTER" = "0" ]; then
  echo "Build complete. Add this to your MCP client config under \\"mcpServers\\":"
  echo "  \\"$SERVER_NAME\\": { \\"command\\": \\"$NODE_BIN\\", \\"args\\": [\\"$SERVER_JS\\"] }"
  exit 0
fi

# Resolve the Claude Desktop config path for this OS (override with MCP_CONFIG_PATH).
if [ -n "$MCP_CONFIG_PATH" ]; then
  CONFIG_PATH="$MCP_CONFIG_PATH"
elif [ "$(uname)" = "Darwin" ]; then
  CONFIG_PATH="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
else
  CONFIG_PATH="$HOME/.config/Claude/claude_desktop_config.json"
fi

MCP_REG_CONFIG="$CONFIG_PATH" MCP_REG_NAME="$SERVER_NAME" MCP_REG_NODE="$NODE_BIN" MCP_REG_JS="$SERVER_JS" \\
  node "$SCRIPT_DIR/mcp-register.mjs"

echo "==> Done. Restart Claude Desktop (or your MCP client) to load \\"$SERVER_NAME\\"."
`;
}

/**
 * Windows installer (PowerShell). Run with `powershell -ExecutionPolicy Bypass -File install.ps1`.
 * Same behavior as install.sh; targets %APPDATA%\\Claude\\claude_desktop_config.json (override: $env:MCP_CONFIG_PATH).
 */
export function installPs1(input: CodegenInput): string {
  const name = slugFromUrl(input.url);
  return `# install.ps1 - build this generated MCP server and register it with Claude Desktop on Windows.
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 --no-register   (build only)
#   $env:MCP_CONFIG_PATH = "C:\\path\\to\\config.json"   (target a specific client config)
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

if ($args -contains "--no-register") {
  Write-Host "Build complete. Register manually: command=$NodeBin args=$ServerJs"
  exit 0
}

if ($env:MCP_CONFIG_PATH) {
  $ConfigPath = $env:MCP_CONFIG_PATH
} else {
  $ConfigPath = Join-Path $env:APPDATA "Claude\\claude_desktop_config.json"
}

$env:MCP_REG_CONFIG = $ConfigPath
$env:MCP_REG_NAME = $ServerName
$env:MCP_REG_NODE = $NodeBin
$env:MCP_REG_JS = $ServerJs
node (Join-Path $ScriptDir "mcp-register.mjs")
if ($LASTEXITCODE -ne 0) { Write-Error "registration failed"; exit 1 }

Write-Host "==> Done. Restart Claude Desktop (or your MCP client) to load $ServerName."
`;
}

export function generateServer(input: CodegenInput): GeneratedServerArtifact {
  const snippet = configSnippet(input);
  const readme = `# ${input.title} - MCP server\n\nAuto-generated from ${input.url} (v${input.version}). Runs locally and may use public HTTP calls plus Playwright-driven browser steps.\n\n## Install (one step)\n\nThis builds the server and registers it with your MCP client (Claude Desktop), then restart the client.\n\n\`\`\`bash\n# macOS / Linux\nbash install.sh\n\`\`\`\n\`\`\`powershell\n# Windows\npowershell -ExecutionPolicy Bypass -File install.ps1\n\`\`\`\n\nThe installer registers the server with an absolute \`node\` path (GUI clients don't inherit your shell PATH).\nTarget a different client config with \`MCP_CONFIG_PATH=/path/to/config.json\`, or pass \`--no-register\` to build only.\n\n## Run manually\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm start\n\`\`\`\n\nBrowser tools use Playwright. Run \`npx playwright install chromium\` once if you use the \`browser_*\` tools, and set \`MCP_BROWSER_PATH\` or \`MCP_BROWSER_CHANNEL=chrome\` if your local Chrome install is not auto-detected.\n\nThe \`claude_desktop_config.json\` snippet is also included if you prefer to wire it up by hand (fix the absolute path).\n`;
  return {
    serverId: input.serverId,
    version: input.version,
    files: [
      { path: "server.ts", content: generateServerSource(input) },
      { path: "package.json", content: packageJson(input) },
      { path: "tsconfig.json", content: tsconfigJson() },
      { path: "claude_desktop_config.json", content: snippet },
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
