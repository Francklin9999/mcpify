import { randomUUID, createHash } from "node:crypto";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { CaptureBundle, LIMITS, scrubHeaders, isSecretField, type LegalMode } from "@mcp/types";
import { assertPublicHttpUrl, type Scraper } from "@mcp/generator/lean";
import { resolveProfile } from "./browser-profile.js";
import { cdpTargetFromEnv, resolveCdpEndpoint, describeCdpTarget, type CdpTarget } from "./browser-connect.js";

/**
 * In-process stealth browser capture for the standalone server. Renders JS and captures XHR/fetch traffic (via
 * CDP) so the standalone builds tools from dynamic / bot-walled sites with NO backend. Everything that the old
 * Python tier-3/4 scraper did is baked in here, in-process:
 *
 *   - a real-browser fingerprint: navigator.webdriver stripped, --enable-automation removed, plugins/languages/
 *     WebGL vendor/permissions patched, AutomationControlled off, a clean (non-"HeadlessChrome") UA;
 *   - auto-preference for the user's REAL installed Chrome/Edge (strongest fingerprint, no download);
 *   - an optional CDP-stealth driver (rebrowser-playwright-core / patchright) that patches the leaks plain
 *     Playwright can't (e.g. Runtime.enable);
 *   - an AUTO-ESCALATION ladder: a cheap headless attempt first, and only when a capture looks blocked does it
 *     climb to real Chrome -> stealth driver -> headful. Easy sites stay fast; hard sites get the heavy stealth.
 *
 * Drivers are lazy-loaded via an indirect import so the static path still works when none is installed and so the
 * bundler never hard-links them. Overrides: MCP_BROWSER_CHANNEL, MCP_BROWSER_DRIVER, MCP_BROWSER_PATH,
 * MCP_BROWSER_HEADLESS, FORGE_BROWSER_ESCALATE=0 (single attempt), MCP_BROWSER_TZ. Set FORGE_BROWSER_PROFILE
 * (clone|real|<path>) to reuse the user's real signed-in Chrome/Edge profile instead of a fresh one — see
 * ./browser-profile.ts.
 */

const NAV_TIMEOUT_MS = Number(process.env["FORGE_BROWSER_TIMEOUT_MS"]) || 30_000;
const SETTLE_MS = Number(process.env["FORGE_BROWSER_SETTLE_MS"]) || 2_500;
const MAX_JSON_BODY = 512_000;
const INTERACT = process.env["SCRAPER_INTERACT"] !== "0";
const TIMEZONE = process.env["MCP_BROWSER_TZ"] || "America/New_York";
const VIEWPORT = { width: 1280, height: 800 };

// Human auth/CAPTCHA handoff: after the whole stealth ladder still hits a wall, open a VISIBLE browser and let the
// user sign in / solve the challenge, then continue capturing in that same (stealthy) session. Needs a display.
const AUTH_HANDOFF = process.env["FORGE_AUTH_HANDOFF"] !== "0";
const AUTH_HANDOFF_TIMEOUT_MS = Number(process.env["FORGE_AUTH_HANDOFF_TIMEOUT_MS"]) || 300_000;
const AUTH_POLL_MS = Number(process.env["FORGE_AUTH_POLL_MS"]) || 2_500;

// A clean modern-Chrome UA per OS, used ONLY to strip the "HeadlessChrome" tell from the bundled headless
// Chromium attempt. Real Chrome (a channel) and headful runs keep their own correct UA + client hints.
const UA_BY_OS: Record<string, string> = {
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  darwin: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  win32: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// Anti-bot / blocked-page markers. A rendered page carrying one (or a near-empty shell with no captured API
// traffic) is a wall, not content -> escalate to a stronger stealth attempt.
export const BOT_MARKERS =
  /captcha|are you (?:a )?human|verify you are human|unusual traffic|just a moment|checking your browser|enable javascript and cookies|access (?:to this page has been )?denied|attention required|sorry[!,. ]+something went wrong|cf-chl|px-captcha|akamai|please verify you are/i;

export interface RawCall {
  method: string;
  rawUrl: string;
  requestHeaders: Record<string, string>;
  requestBodySchema?: Record<string, unknown>;
  requestBody?: string;
  responseSchema?: Record<string, unknown>;
  statusCode: number;
  contentType: string;
}

/** A captured XHR/fetch as the Chrome extension reports it (bodies already decoded to UTF-8 strings on its side). */
export interface ExtNetItem {
  method?: string;
  url?: string;
  requestHeaders?: Record<string, string>;
  reqContentType?: string;
  requestPostData?: string;
  status?: number;
  contentType?: string;
  responseBody?: string;
}

const MAX_REQUEST_BODY = LIMITS.maxRequestBody;

/**
 * Read a request's body as a UTF-8 string, transparently decompressing it. Browsers gzip/br/deflate some POST
 * bodies (YouTube's InnerTube does), which `request.postData()` returns as a mangled string - so we go through
 * `postDataBuffer()` and decode by the content-encoding header (falling back to gzip magic-byte sniffing).
 */
function decodeRequestBody(req: any): string | undefined {
  let buf: Buffer | null = null;
  try {
    buf = req.postDataBuffer?.() ?? null;
  } catch {
    buf = null;
  }
  if (buf && buf.length) {
    const enc = String(req.headers?.()?.["content-encoding"] || "").toLowerCase();
    try {
      if (enc.includes("gzip") || (buf[0] === 0x1f && buf[1] === 0x8b)) return gunzipSync(buf).toString("utf8");
      if (enc.includes("br")) return brotliDecompressSync(buf).toString("utf8");
      if (enc.includes("deflate")) return inflateSync(buf).toString("utf8");
      return buf.toString("utf8");
    } catch {
      return buf.toString("utf8"); // not actually compressed / unknown codec - take the raw text
    }
  }
  try {
    return req.postData?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Redact secret-named fields from a parsed JSON body (bounded depth) so a captured body carries no credentials. */
function scrubJsonSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubJsonSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretField(k) ? "__redacted__" : scrubJsonSecrets(v, depth + 1);
  }
  return out;
}

/**
 * Build the body that a generated tool will REPLAY. A scrubbed body marks secret fields as the string
 * "__redacted__" (good for a schema/preview), but replaying that placeholder corrupts structured request bodies —
 * e.g. YouTube InnerTube rejects a replay with `"consistencyTokenJars":"__redacted__"` as HTTP 400 "Invalid value".
 * So for the replay copy we OMIT scrubbed fields entirely: the credential is still gone (strictly safer than sending
 * a placeholder), and the remaining boilerplate replays cleanly. Returns undefined if nothing replayable is left.
 */
function replayBodyFromScrubbed(scrubbed: unknown): unknown {
  if (scrubbed === "__redacted__") return undefined;
  if (Array.isArray(scrubbed)) return scrubbed.map(replayBodyFromScrubbed).filter((v) => v !== undefined);
  if (scrubbed === null || typeof scrubbed !== "object") return scrubbed;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scrubbed as Record<string, unknown>)) {
    const stripped = replayBodyFromScrubbed(v);
    if (stripped !== undefined) out[k] = stripped;
  }
  return out;
}

// One launch configuration in the escalation ladder. tier in the bundle reflects the stealth level reached.
interface Attempt {
  driver: "core" | "stealth";
  channel?: string;
  headless: boolean;
}
function tierFor(att: Attempt): 2 | 3 | 4 {
  if (!att.headless) return 4; // headful is the strongest signal
  return att.driver === "stealth" || att.channel ? 3 : 2;
}

const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

/** Import a Chromium driver. "core" = playwright(-core); "stealth" = a CDP-patched drop-in. Null if none. */
async function importDriver(kind: "core" | "stealth"): Promise<any | null> {
  const candidates =
    kind === "core"
      ? ["playwright-core", "playwright"]
      : [process.env["MCP_BROWSER_DRIVER"], "rebrowser-playwright-core", "patchright", "rebrowser-playwright"];
  for (const mod of candidates) {
    if (!mod) continue;
    try {
      const m = await dynamicImport(mod);
      const chromium = m.chromium ?? m.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* try the next driver */
    }
  }
  return null;
}

/** Any launchable driver (stealth preferred). Used by playwrightAvailable. */
async function importChromium(): Promise<any | null> {
  return (await importDriver("stealth")) || (await importDriver("core"));
}

let stealthCache: boolean | undefined;
/** Is a CDP-stealth driver installed (bundled as an optionalDependency, or added by the user)? Cached. */
async function hasStealthDriver(): Promise<boolean> {
  if (stealthCache !== undefined) return stealthCache;
  return (stealthCache = !!(await importDriver("stealth")));
}

let channelCache: string | null | undefined;
/**
 * Detect an installed real browser to drive via a Playwright "channel" (no download, strongest fingerprint).
 * Honors MCP_BROWSER_CHANNEL; yields to an explicit MCP_BROWSER_PATH. Returns "chrome"/"msedge" or undefined.
 */
async function detectChannel(): Promise<string | undefined> {
  const forced = process.env["MCP_BROWSER_CHANNEL"];
  if (forced) return forced;
  if (process.env["MCP_BROWSER_PATH"]) return undefined; // explicit executable wins; no channel
  if (channelCache !== undefined) return channelCache ?? undefined;
  channelCache = null;
  try {
    const fs: any = await dynamicImport("node:fs");
    const has = (p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    };
    if (process.platform === "darwin") {
      if (has("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) channelCache = "chrome";
      else if (has("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")) channelCache = "msedge";
    } else if (process.platform === "win32") {
      if (["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].some(has)) channelCache = "chrome";
      else if (has("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")) channelCache = "msedge";
    } else {
      if (["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some(has)) channelCache = "chrome";
      else if (["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"].some(has)) channelCache = "msedge";
    }
  } catch {
    channelCache = null;
  }
  return channelCache ?? undefined;
}

/** Is a display available for a headful escalation? (Desktops yes; a headless Linux server without X/Wayland no.) */
function displayAvailable(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return !!(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]);
}

let corePathCache: string | null | undefined;
/** Path to the bundled-Chromium binary that playwright-core manages (so a stealth driver can reuse it). */
async function coreChromiumPath(): Promise<string | undefined> {
  if (corePathCache !== undefined) return corePathCache ?? undefined;
  corePathCache = null;
  try {
    const core = await importDriver("core");
    const fs: any = await dynamicImport("node:fs");
    const p = core?.executablePath?.();
    if (p && fs.existsSync(p)) corePathCache = p;
  } catch {
    corePathCache = null;
  }
  return corePathCache ?? undefined;
}

let installAttempted = false;
/**
 * Ensure a bundled Chromium exists, installing it ONCE on first use (playwright-core ships no binary, so the npm
 * install stays tiny). Best-effort + bounded; FORGE_NO_BROWSER_INSTALL=1 opts out. Progress goes to stderr.
 */
async function ensureChromiumInstalled(chromium: any): Promise<void> {
  const fs: any = await dynamicImport("node:fs");
  try {
    if (chromium?.executablePath && fs.existsSync(chromium.executablePath())) return;
  } catch {
    /* fall through to install */
  }
  if (installAttempted || process.env["FORGE_NO_BROWSER_INSTALL"] === "1") return;
  installAttempted = true;
  try {
    const cp: any = await dynamicImport("node:child_process");
    const mod: any = await dynamicImport("node:module");
    const path: any = await dynamicImport("node:path");
    const require = mod.createRequire(import.meta.url);
    // playwright-core/cli.js isn't an exported subpath, so resolve the package main and walk to its dir.
    let cliPath = "";
    for (const pkg of ["playwright-core", "playwright"]) {
      try {
        let dir = path.dirname(require.resolve(pkg));
        for (let i = 0; i < 5 && !fs.existsSync(path.join(dir, "package.json")); i++) dir = path.dirname(dir);
        const cli = path.join(dir, "cli.js");
        if (fs.existsSync(cli)) {
          cliPath = cli;
          break;
        }
      } catch {
        /* not resolvable; try the next */
      }
    }
    if (!cliPath) return;
    console.error("[urlmcp] Installing Chromium for browser capture (one-time, ~20-40s)...");
    await new Promise<void>((resolve) => {
      const child = cp.spawn(process.execPath, [cliPath, "install", "chromium"], { stdio: ["ignore", "inherit", "inherit"], timeout: 180_000 });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    console.error("[urlmcp] Chromium install finished.");
  } catch {
    /* best-effort: if install fails, capture falls back to static */
  }
}

/** Whether a browser capture is possible here. A real Chrome channel needs no bundled-Chromium download. Cached. */
let availableCache: boolean | undefined;
export async function playwrightAvailable(): Promise<boolean> {
  if (process.env["FORGE_BROWSER"] === "0") return false; // config toggle, not cached
  if (availableCache !== undefined) return availableCache;
  const chromium = await importChromium();
  if (!chromium) return (availableCache = false); // no driver installed -> static-only
  if (await detectChannel()) return (availableCache = true); // can launch via real Chrome, no download needed
  await ensureChromiumInstalled(chromium); // first-run binary fetch (playwright-core ships none)
  try {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ["--no-sandbox"], timeout: 8_000 });
    await browser.close();
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

/**
 * Runs in the PAGE context (serialized by addInitScript): patch the JS-detectable automation tells. Mirrors the
 * stealth the old Python tier-3 used, minus what only a patched CDP layer can hide (that's the stealth driver).
 */
function stealthInit(): void {
  // Runs in the page: globalThis === window here. Routed through `g` so it needs no DOM lib at compile time.
  const g: any = globalThis;
  const nav: any = g.navigator;
  const def = (obj: any, prop: string, get: () => unknown) => {
    try {
      Object.defineProperty(obj, prop, { get, configurable: true });
    } catch {
      /* ignore */
    }
  };
  def(nav, "webdriver", () => undefined);
  def(nav, "languages", () => ["en-US", "en"]);
  try {
    if (!nav.hardwareConcurrency) def(nav, "hardwareConcurrency", () => 8);
  } catch {
    /* ignore */
  }
  def(nav, "deviceMemory", () => 8);
  try {
    if (!g.chrome) g.chrome = {};
    if (!g.chrome.runtime) g.chrome.runtime = {};
  } catch {
    /* ignore */
  }
  def(nav, "plugins", () => {
    const arr: any = [0, 1, 2].map((i) => ({ name: "Plugin " + i, filename: "internal-" + i + ".so", description: "" }));
    arr.item = (i: number) => arr[i];
    arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) || null;
    arr.refresh = () => {};
    return arr;
  });
  try {
    const perms: any = nav.permissions;
    const orig = perms?.query?.bind(perms);
    if (orig) {
      perms.query = (params: any) =>
        params && params.name === "notifications"
          ? Promise.resolve({ state: g.Notification ? g.Notification.permission : "prompt" })
          : orig(params);
    }
  } catch {
    /* ignore */
  }
  for (const Ctx of [g.WebGLRenderingContext, g.WebGL2RenderingContext]) {
    try {
      if (!Ctx) continue;
      const getParam = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function (p: number) {
        if (p === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
        return getParam.call(this, p);
      };
    } catch {
      /* ignore */
    }
  }
}

function stealthArgs(headless: boolean): string[] {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
  ];
  if (!headless) args.push("--start-maximized");
  return args;
}

/** Strip "HeadlessChrome" only for the bundled-headless attempt; trust real Chrome / headful to carry a clean UA. */
function uaFor(att: Attempt): string | undefined {
  if (att.channel || !att.headless) return undefined;
  return UA_BY_OS[process.platform] || UA_BY_OS["linux"];
}

function inferSchema(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return { type: "array" };
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    properties[k] = { type: t === "object" ? "object" : t };
  }
  return { type: "object", properties };
}

const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$/i;

/** Path with id-like segments templated to {id} (so the heuristic can build a parameterized tool). */
function templatePath(pathname: string): { urlPattern: string } {
  const segs = pathname.split("/");
  let n = 0;
  const out = segs.map((s) => (s && ID_SEG.test(s) ? `{${n++ === 0 ? "id" : "id" + n}}` : s));
  return { urlPattern: out.join("/") || "/" };
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1]?.trim().slice(0, 240) || undefined;
}

/** Visible text only: drop script/style/noscript bodies + all tags, collapse whitespace. */
function stripTags(html: string): string {
  return html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function visibleTextLength(html: string): number {
  return stripTags(html).length;
}

/** Register a CDP-level XHR/fetch listener on the page; pushes scrubbed NetworkCapture-shaped calls. */
function attachNetworkCapture(page: any, calls: RawCall[]): void {
  page.on("response", async (resp: any) => {
    if (calls.length >= LIMITS.maxNetworkCalls) return;
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;
      const rawUrl = resp.url();
      if (!/^https?:\/\//i.test(rawUrl) || rawUrl.length > 4_000) return;
      const headers = resp.headers() || {};
      const contentType = String(headers["content-type"] || "");

      let responseSchema: Record<string, unknown> | undefined;
      if (/json/i.test(contentType)) {
        const len = Number(headers["content-length"] || "0");
        if (!len || len <= MAX_JSON_BODY) {
          try {
            responseSchema = inferSchema(await resp.json());
          } catch {
            /* unreadable / not actually json */
          }
        }
      }

      let requestBodySchema: Record<string, unknown> | undefined;
      let requestBody: string | undefined;
      try {
        const reqCt = String(req.headers()["content-type"] || "");
        if (/json/i.test(reqCt)) {
          const decoded = decodeRequestBody(req);
          if (decoded && decoded.length <= MAX_JSON_BODY) {
            const scrubbed = scrubJsonSecrets(JSON.parse(decoded));
            requestBodySchema = inferSchema(scrubbed);
            // Keep the body so a POST/PUT API can be replayed with its fixed boilerplate intact, but OMIT scrubbed
            // secret fields (a "__redacted__" placeholder would corrupt structured bodies; see replayBodyFromScrubbed).
            const serialized = JSON.stringify(replayBodyFromScrubbed(scrubbed));
            if (serialized.length <= MAX_REQUEST_BODY) requestBody = serialized;
          }
        }
      } catch {
        /* non-json / unreadable body */
      }

      calls.push({
        method: String(req.method() || "GET").toUpperCase(),
        rawUrl,
        requestHeaders: scrubHeaders(req.headers() || {}),
        requestBodySchema,
        requestBody,
        responseSchema,
        statusCode: Number(resp.status()) || 0,
        contentType,
      });
    } catch {
      /* a capture error must never break the page */
    }
  });
}

/**
 * Convert the extension's already-decoded network items into the same RawCall shape attachNetworkCapture produces,
 * running identical JSON schema-inference + secret-scrubbing so an extension-captured bundle is indistinguishable
 * from a Playwright-captured one downstream (one source of truth for the wire shape).
 */
export function extNetworkToRaw(items: ExtNetItem[]): RawCall[] {
  const out: RawCall[] = [];
  for (const it of items || []) {
    if (out.length >= LIMITS.maxNetworkCalls) break;
    const rawUrl = String(it.url || "");
    if (!/^https?:\/\//i.test(rawUrl) || rawUrl.length > 4_000) continue;
    const contentType = String(it.contentType || "");

    let responseSchema: Record<string, unknown> | undefined;
    if (/json/i.test(contentType) && it.responseBody && it.responseBody.length <= MAX_JSON_BODY) {
      try {
        responseSchema = inferSchema(JSON.parse(it.responseBody));
      } catch {
        /* not actually json */
      }
    }

    let requestBodySchema: Record<string, unknown> | undefined;
    let requestBody: string | undefined;
    if (/json/i.test(String(it.reqContentType || "")) && it.requestPostData && it.requestPostData.length <= MAX_JSON_BODY) {
      try {
        const scrubbed = scrubJsonSecrets(JSON.parse(it.requestPostData));
        requestBodySchema = inferSchema(scrubbed);
        // Replay copy omits scrubbed secret fields (a "__redacted__" placeholder corrupts structured bodies).
        const serialized = JSON.stringify(replayBodyFromScrubbed(scrubbed));
        if (serialized.length <= MAX_REQUEST_BODY) requestBody = serialized;
      } catch {
        /* non-json / unreadable body */
      }
    }

    out.push({
      method: String(it.method || "GET").toUpperCase(),
      rawUrl,
      requestHeaders: scrubHeaders(it.requestHeaders || {}),
      requestBodySchema,
      requestBody,
      responseSchema,
      statusCode: Number(it.status) || 0,
      contentType,
    });
  }
  return out;
}

// Inputs whose VALUE must never be kept in the captured DOM: password fields + other credential-ish inputs. We
// strip ONLY the value attribute (leaving the element so forms/structure stay analyzable). Browsers usually don't
// serialize typed values into outerHTML, but some frameworks mirror them into value="" — so we redact defensively,
// honoring "if it's a login we don't look at his password and stuff".
const SENSITIVE_INPUT =
  /type\s*=\s*["']?password|autocomplete\s*=\s*["']?(?:current-password|new-password|one-time-code)|(?:name|id)\s*=\s*["']?[^"'>\s]*(?:passw(?:or)?d|pwd|otp|one[-_]?time|cvv|cvc|ccv|card[-_]?number|ssn|secret|security[-_]?code)/i;

/** Redact credential input values from captured HTML so a login page's typed password/OTP/card never lands in a bundle. */
export function redactSensitiveHtml(html: string): string {
  return html.replace(/<input\b[^>]*>/gi, (tag) =>
    SENSITIVE_INPUT.test(tag) ? tag.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+)/gi, ' value="__redacted__"') : tag,
  );
}

/**
 * Clamp captured request headers to what the CaptureBundle contract allows so one oversized real-world header (e.g.
 * LinkedIn's multi-KB `x-li-query-map`) can't fail-validate an otherwise-good capture: cap value length, drop
 * pathological key names, and keep at most maxHeaders. Values are already secret-scrubbed upstream.
 */
function capHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(h || {})) {
    if (n >= LIMITS.maxHeaders) break;
    if (!k || k.length > 256) continue;
    out[k] = String(v ?? "").slice(0, LIMITS.maxHeaderValue);
    n++;
  }
  return out;
}

/**
 * Build the validated CaptureBundle from a rendered HTML doc + raw captured calls. Shared by every capture path
 * (fresh Playwright launch, CDP attach, the browser extension) so they all emit an identical bundle shape: HTML is
 * capped, calls are deduped by (method, templated-path) and templated, and the whole thing is parsed against the
 * keystone CaptureBundle contract.
 */
export function assembleBundle(opts: {
  url: string;
  legalMode: LegalMode;
  tier: 2 | 3 | 4;
  html: string;
  raw: RawCall[];
  title?: string;
  renderedWithJs?: boolean;
}): CaptureBundle {
  const html = redactSensitiveHtml((opts.html || "").slice(0, LIMITS.maxHtml));
  const network = dedupeCalls(opts.raw)
    .slice(0, LIMITS.maxNetworkCalls)
    .map((c) => ({ ...templatePath(safePath(c.rawUrl)), ...c, requestHeaders: capHeaders(c.requestHeaders) }));
  return CaptureBundle.parse({
    bundleId: randomUUID(),
    source: "scraper",
    url: opts.url,
    capturedAt: new Date().toISOString(),
    legalMode: opts.legalMode,
    tier: opts.tier,
    dom: { html, domHash: createHash("sha256").update(html).digest("hex") },
    network,
    meta: { title: opts.title ?? extractTitle(html), robotsAllowed: true, renderedWithJs: opts.renderedWithJs ?? true },
  });
}

/** Bounded, fail-soft interactions to surface action-only XHR; restores the original document afterward. */
async function interactionPass(page: any): Promise<void> {
  if (!INTERACT) return;
  let start = "";
  try {
    start = page.url();
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 2; i++) {
    try {
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    } catch {
      break;
    }
    try {
      await page.waitForLoadState("networkidle", { timeout: 2_000 });
    } catch {
      await page.waitForTimeout(400).catch(() => {});
    }
  }
  try {
    const box = await page.$("input[type=search], input[name*='q' i], input[name*='search' i], input[name*='query' i], [role=searchbox]");
    if (box) {
      await box.fill("test");
      await box.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  try {
    const more = await page.$("button:has-text('Load more'), button:has-text('Show more'), a[rel=next]");
    if (more) {
      await more.click({ timeout: 2_000 });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  // Restore the requested document if an interaction navigated away (keeps DOM + relative-link base aligned).
  try {
    if (start && page.url().split("#")[0] !== start.split("#")[0]) {
      await page.goto(start, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Plan the escalation ladder from what's available here. Cheapest-but-strong first; each later rung adds stealth
 * (real Chrome -> CDP-stealth driver -> headful). Rungs that would be identical (no Chrome, no driver, no display)
 * collapse, so a bare headless server still gets exactly one bundled-Chromium attempt — unchanged behavior.
 */
export async function planBrowserAttempts(): Promise<Attempt[]> {
  const baseHeadless = process.env["MCP_BROWSER_HEADLESS"] !== "0";
  const escalate = process.env["FORGE_BROWSER_ESCALATE"] !== "0";
  const channel = await detectChannel(); // real Chrome/Edge, or undefined -> bundled Chromium
  const stealth = await hasStealthDriver();
  const display = displayAvailable();
  const forcedDriver = !!process.env["MCP_BROWSER_DRIVER"];
  // A stealth driver is only paired with a real channel (avoids Chromium-revision skew vs the driver's fork);
  // when the user forces MCP_BROWSER_DRIVER we honor it regardless.
  const stealthUsable = forcedDriver || (stealth && !!channel);

  const attempts: Attempt[] = [];
  attempts.push({ driver: stealthUsable ? "stealth" : "core", channel, headless: baseHeadless });
  if (escalate) {
    attempts.push({ driver: stealthUsable ? "stealth" : "core", channel, headless: baseHeadless });
    attempts.push({ driver: stealthUsable ? "stealth" : "core", channel, headless: display ? false : baseHeadless });
  }
  // Dedupe identical rungs (keep first occurrence / order).
  const seen = new Set<string>();
  return attempts.filter((a) => {
    const key = `${a.driver}|${a.channel ?? ""}|${a.headless}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A rendered page is "blocked" if it carries an anti-bot marker, or is a near-empty shell with no captured API. */
export function looksBlocked(bundle: CaptureBundle): boolean {
  const html = bundle.dom.html || "";
  const title = bundle.meta?.title || "";
  if (BOT_MARKERS.test(title) || BOT_MARKERS.test(html.slice(0, 60_000))) return true;
  return visibleTextLength(html) < 500 && bundle.network.length === 0;
}

// A visible password field is the strongest "this is a sign-in wall" signal; pair it with a login-ish title/URL
// (or a thin, form-dominated page) so a header login dropdown on a content page doesn't trip a false handoff.
const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const LOGIN_MARKERS = /\b(sign[ -]?in|log[ -]?in|log[ -]?on|authenticate|create (?:an )?account|your account)\b/i;
const LOGIN_URL = /\/(login|log-in|signin|sign-in|sign_in|auth(?:enticate)?|authwall|session|account|sso|uas\/login)\b/i;
// Interstitial phrases that ONLY appear on a real auth wall (not a header "Sign in" link). LinkedIn, X/Twitter,
// Instagram, Reddit, Quora, Pinterest etc. gate content behind one of these WITHOUT a password field in the
// initial DOM (the password step is a later page/modal), so PASSWORD_FIELD alone misses them.
const AUTH_WALL_TEXT =
  /sign\s?in to (?:continue|view|see|access|read|watch)|log\s?in to (?:continue|view|see|access|read|watch)|join (?:linkedin|to view|now to)|please (?:sign|log)\s?in to|sign\s?in to your account to|members? log\s?in|you must (?:be )?(?:signed|logged)\s?in|create an account or sign in|to continue, (?:sign|log)\s?in/i;

/**
 * Whether a rendered page is a login/sign-in wall (more stealth won't help — only a human signing in will).
 * Two routes: (1) a password field on a login-ish/thin page; (2) an auth INTERSTITIAL — a thin page whose visible
 * text is an explicit "sign in to continue / join to view" gate, even with no password field yet (LinkedIn/X/IG).
 */
export function hasLoginWall(bundle: CaptureBundle): boolean {
  const html = bundle.dom.html || "";
  const title = bundle.meta?.title || "";
  if (PASSWORD_FIELD.test(html)) {
    if (LOGIN_MARKERS.test(title) || LOGIN_URL.test(bundle.url || "")) return true;
    if (visibleTextLength(html) < 2_000) return true; // a password field on a thin page => the page IS the wall
  }
  // Auth interstitial without a password field: require a thin page (so a content page with a buried "join" CTA
  // doesn't trip) AND an interstitial-specific phrase AND no real captured API traffic to mine instead.
  if (bundle.network.length === 0 && visibleTextLength(html) < 6_000 && AUTH_WALL_TEXT.test(stripTags(html))) return true;
  return false;
}

/**
 * A wall only a HUMAN can clear: a real anti-bot challenge/CAPTCHA, or a sign-in page. This deliberately does NOT
 * include the thin-shell heuristic looksBlocked() uses for ladder escalation - a small SSR page is a reason to try
 * more stealth, not to summon a person (that would hang an automated capture on any near-empty page).
 */
export function needsHuman(bundle: CaptureBundle): boolean {
  const html = bundle.dom.html || "";
  const title = bundle.meta?.title || "";
  const botWall = BOT_MARKERS.test(title) || BOT_MARKERS.test(html.slice(0, 60_000));
  return botWall || hasLoginWall(bundle);
}

// A real CAPTCHA / challenge page is SHORT. needsHuman()'s bare BOT_MARKERS check false-positives on long content
// pages that merely mention "verify"/"denied"/etc. somewhere (a logged-in LinkedIn feed tripped it) — so for the
// decision to PAUSE a live page for the human we additionally require the page to be thin.
const CAPTCHA_MAX_TEXT = 3_000;

/**
 * Precise "this live page is a wall only a HUMAN can clear" check — a login/sign-in wall, or a CAPTCHA/challenge
 * that is ALSO thin (so a content page that merely contains a bot-ish word doesn't trigger a pause). Pure so it can
 * be unit-tested; pageIsHumanWall() feeds it the current rendered page.
 */
export function isHumanWall(p: { html: string; title?: string; url?: string; network?: unknown[] }): boolean {
  const fake = { dom: { html: p.html }, meta: { title: p.title }, url: p.url, network: p.network || [] } as unknown as CaptureBundle;
  if (hasLoginWall(fake)) return true;
  const botWall = BOT_MARKERS.test(p.title || "") || BOT_MARKERS.test((p.html || "").slice(0, 60_000));
  return botWall && visibleTextLength(p.html || "") < CAPTCHA_MAX_TEXT;
}

/** isHumanWall() against the live rendered page (its current DOM/title), for deciding whether to pause for the human. */
async function pageIsHumanWall(page: any, url: string, network: unknown[]): Promise<boolean> {
  try {
    const html = (await page.content()) || "";
    const title = (await page.title().catch(() => "")) || "";
    return isHumanWall({ html, title, url, network });
  } catch {
    return false; // mid-navigation: don't pause on a torn-down context
  }
}

/** Higher is better: captured API traffic dominates, then visible content; a blocked page is penalized. */
function scoreBundle(bundle: CaptureBundle): number {
  return bundle.network.length * 1000 + visibleTextLength(bundle.dom.html || "") - (looksBlocked(bundle) ? 1_000_000 : 0);
}

/**
 * One launch+navigate+capture for a single ladder rung. Throws if the browser can't be launched for this config.
 * `onLoaded` (optional) runs after the page settles and before interaction/capture - the auth handoff uses it to
 * pause the open, visible page until the human has signed in / solved the challenge.
 */
async function captureOnce(
  url: string,
  legalMode: LegalMode,
  att: Attempt,
  onLoaded?: (page: any) => Promise<void>,
): Promise<CaptureBundle> {
  let chromium = await importDriver(att.driver);
  if (!chromium) {
    chromium = await importDriver("core");
    if (!chromium) throw new Error("no browser driver installed (add playwright-core, or set FORGE_BROWSER=0)");
    att = { ...att, driver: "core" };
  }

  let executablePath = process.env["MCP_BROWSER_PATH"] || undefined;
  if (!att.channel && !executablePath) {
    const core = await importDriver("core");
    if (core) await ensureChromiumInstalled(core);
    if (att.driver === "stealth") {
      // A stealth driver without a real channel must reuse the bundled-Chromium binary explicitly.
      executablePath = await coreChromiumPath();
      if (!executablePath) throw new Error("stealth driver has no Chromium binary to drive");
    }
  }

  // Real-profile login reuse: when enabled, drive the user's real (or cloned) Chrome/Edge profile so the page opens
  // already signed into their Gmail/Google/etc. instead of a fresh, empty profile. Only engages with a real channel.
  const profile = resolveProfile(att.channel, (m) => console.error(m));
  const args = stealthArgs(att.headless);
  if (profile) args.push(`--profile-directory=${profile.profileDirectory}`);

  const launchOpts: Record<string, unknown> = {
    headless: att.headless,
    channel: att.channel,
    executablePath,
    chromiumSandbox: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args,
    timeout: NAV_TIMEOUT_MS,
  };
  const contextOpts: Record<string, unknown> = {
    locale: "en-US",
    timezoneId: TIMEZONE,
    viewport: att.headless ? VIEWPORT : null,
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
  };
  const ua = uaFor(att);
  if (ua) contextOpts["userAgent"] = ua;

  // A persistent context drives an on-disk profile (logged-in) and owns its own page; a plain launch gets a fresh,
  // throwaway profile. Persistent merges launch + context options into one call and has no separate browser handle.
  let browser: any;
  let context: any;
  if (profile) {
    context = await chromium.launchPersistentContext(profile.userDataDir, { ...launchOpts, ...contextOpts });
  } else {
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext(contextOpts);
  }

  const calls: RawCall[] = [];
  try {
    await context.addInitScript(stealthInit);
    const page = (profile && context.pages?.()[0]) || (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    attachNetworkCapture(page, calls);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
    } catch {
      await page.waitForTimeout(SETTLE_MS).catch(() => {});
    }
    if (onLoaded) await onLoaded(page);
    await interactionPass(page);

    let landed = url;
    try {
      landed = page.url() || url;
    } catch {
      /* ignore */
    }
    if (/^https?:\/\//i.test(landed)) await assertPublicHttpUrl(landed, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });

    const html = await page.content();
    return assembleBundle({ url, legalMode, tier: tierFor(att), html, raw: calls });
  } finally {
    if (browser) await browser.close().catch(() => {});
    else await context.close().catch(() => {});
  }
}

/**
 * Capture by ATTACHING to a browser the user is already running (their real, signed-in session) over CDP, instead
 * of launching a fresh throwaway Chromium. Reuses the live context (cookies + logins), opens one page, drives the
 * same navigate -> settle -> interaction -> capture pipeline, then closes only that page and disconnects — the
 * user's browser keeps running. Tier 4: it's a real browser carrying a real session, the strongest signal there is.
 */
async function captureOverCdp(url: string, legalMode: LegalMode, target: CdpTarget): Promise<CaptureBundle> {
  const endpoint = await resolveCdpEndpoint(target, (m) => console.error(m));
  const chromium = (await importDriver("core")) || (await importDriver("stealth"));
  if (!chromium?.connectOverCDP) throw new Error("installed browser driver has no connectOverCDP (need playwright-core)");

  const browser = await chromium.connectOverCDP(endpoint, { timeout: NAV_TIMEOUT_MS });
  try {
    // Reuse the user's existing (logged-in) context so cookies/sessions are present; only fall back to a new one
    // if the attached browser somehow exposes none. Do NOT addInitScript here — that would inject our stealth
    // patches into every one of the user's real tabs; the real browser needs no spoofing anyway.
    const context = browser.contexts?.()[0] || (await browser.newContext());
    const calls: RawCall[] = [];
    const page = await context.newPage();
    try {
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      attachNetworkCapture(page, calls);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      try {
        await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
      } catch {
        await page.waitForTimeout(SETTLE_MS).catch(() => {});
      }

      // If the attached (visible) browser landed on a sign-in / CAPTCHA wall, PAUSE and let the user complete it in
      // their own window, then continue capturing the authenticated page. Gated to a real wall (not a logged-in
      // content page that merely mentions a bot-word) and a display, so a logged-in feed never pauses and a headless
      // attach can't hang. FORGE_AUTH_HANDOFF=0 disables.
      if (AUTH_HANDOFF && displayAvailable() && (await pageIsHumanWall(page, url, calls))) {
        await awaitHumanClear(url, page);
      }
      await interactionPass(page);

      let landed = url;
      try {
        landed = page.url() || url;
      } catch {
        /* ignore */
      }
      if (/^https?:\/\//i.test(landed)) await assertPublicHttpUrl(landed, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });

      const html = await page.content();
      return assembleBundle({ url, legalMode, tier: 4, html, raw: calls });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // For a connectOverCDP browser, close() disconnects the CDP session; it does NOT terminate a browser Playwright
    // didn't launch, so the user's window stays open.
    await browser.close().catch(() => {});
  }
}

/** The strongest stealth config we can assemble here, forced HEADFUL so a human can interact with the window. */
async function strongestAttempt(): Promise<Attempt> {
  const channel = await detectChannel();
  const stealth = await hasStealthDriver();
  const forcedDriver = !!process.env["MCP_BROWSER_DRIVER"];
  const stealthUsable = forcedDriver || (stealth && !!channel);
  return { driver: stealthUsable ? "stealth" : "core", channel, headless: false };
}

/** Live "is this still a wall?" check on an OPEN page (CAPTCHA marker, or still on a sign-in form). */
async function pageIsWalled(page: any): Promise<boolean> {
  try {
    const html = (await page.content()) || "";
    const title = (await page.title().catch(() => "")) || "";
    if (BOT_MARKERS.test(title) || BOT_MARKERS.test(html.slice(0, 60_000))) return true;
    if (PASSWORD_FIELD.test(html)) return true; // still sitting on a sign-in form
    return visibleTextLength(html) < 300; // a near-blank transition: keep waiting
  } catch {
    return true; // mid-navigation (execution context torn down) — treat as not-yet-cleared
  }
}

/** Best-effort in-page banner telling the user what to do, right in the window they're looking at. */
async function showHandoffBanner(page: any): Promise<void> {
  try {
    await page.evaluate(() => {
      const g: any = globalThis;
      const d = g.document;
      if (!d || d.getElementById("__urlmcp_banner__")) return;
      const bar = d.createElement("div");
      bar.id = "__urlmcp_banner__";
      bar.textContent = "urlmcp — please sign in / solve the CAPTCHA in this window. Capture continues automatically once you're through. Your password is never captured.";
      bar.setAttribute(
        "style",
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b5;color:#fff;font:600 14px/1.6 system-ui,Arial,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.35)",
      );
      d.documentElement.appendChild(bar);
    });
  } catch {
    /* CSP / no document: the visible window + stderr message still guide the user */
  }
}

async function removeHandoffBanner(page: any): Promise<void> {
  try {
    await page.evaluate(() => {
      const el = (globalThis as any).document?.getElementById("__urlmcp_banner__");
      if (el) el.remove();
    });
  } catch {
    /* ignore */
  }
}

/** Poll until the human has cleared the wall (no CAPTCHA, off the sign-in form), or the deadline passes. */
async function waitForHuman(page: any, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    await page.waitForTimeout(AUTH_POLL_MS).catch(() => {});
    if (!(await pageIsWalled(page))) return true;
  }
  return false;
}

/**
 * Pause an OPEN, visible page until the human clears a sign-in / CAPTCHA wall, then let the now-authenticated page
 * settle so its post-login XHR is captured. The caller has already decided the page IS a wall. Shared by the managed
 * headful handoff AND the CDP-attach path (which pauses the user's own browser window). PRIVACY: we never read what
 * the user types — waitForHuman polls only whether the wall is *gone* (page state, not field values), and captured
 * DOM has credential input values redacted ([[redactSensitiveHtml]]).
 */
async function awaitHumanClear(url: string, page: any): Promise<void> {
  const mins = Math.max(1, Math.round(AUTH_HANDOFF_TIMEOUT_MS / 60_000));
  console.error("\n[urlmcp] ===================== ACTION NEEDED =====================");
  console.error(`[urlmcp] ${url} is behind a sign-in / CAPTCHA wall.`);
  console.error("[urlmcp] A browser window is open — please SIGN IN or SOLVE THE CAPTCHA there.");
  console.error(`[urlmcp] urlmcp will continue automatically once you're through (waiting up to ${mins} min).`);
  console.error("[urlmcp] Your password / what you type is NEVER captured or stored.");
  console.error("[urlmcp] =========================================================\n");
  await showHandoffBanner(page);
  const cleared = await waitForHuman(page, Date.now() + AUTH_HANDOFF_TIMEOUT_MS);
  await removeHandoffBanner(page);
  if (cleared) {
    // Let the now-authenticated page settle so its post-login XHR/fetch is captured into tools.
    try {
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
    } catch {
      await page.waitForTimeout(SETTLE_MS).catch(() => {});
    }
  }
  console.error(
    cleared
      ? "[urlmcp] Wall cleared — continuing capture in the same authenticated session."
      : "[urlmcp] Timed out waiting for sign-in/CAPTCHA; capturing the current page as-is.",
  );
}

/**
 * Last-resort capture: open a VISIBLE, max-stealth browser, let the human sign in / solve the CAPTCHA, then
 * continue capturing the now-authenticated page in the SAME session. Reuses captureOnce (same stealth, network
 * capture, interaction pass) with an onLoaded hook that does the human pause.
 */
async function captureWithHumanHandoff(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
  const att = await strongestAttempt();
  return captureOnce(url, legalMode, att, async (page) => {
    if (await pageIsWalled(page)) await awaitHumanClear(url, page); // a headful render that already got through is skipped
  });
}

/**
 * Default capture source when nothing is explicitly configured: prefer the person's REAL, signed-in Chrome/Edge —
 * launch a clone of their profile with a debug port and attach, so capture runs in their logged-in session — when
 * that's realistically possible (a real browser is installed AND a display exists for the visible window + sign-in
 * pause). Otherwise undefined, so capture uses the managed stealth ladder ("otherwise use the other approach").
 * Opt out with FORGE_USE_REAL_BROWSER=0. The launched window is reused across captures (the launcher reattaches).
 */
async function autoRealChromeTarget(): Promise<CdpTarget | undefined> {
  if ((process.env["FORGE_BROWSER_CDP"] || "").trim()) return undefined; // explicit FORGE_BROWSER_CDP already handled (incl. "off")
  if (process.env["FORGE_USE_REAL_BROWSER"] === "0") return undefined;
  if (process.env["FORGE_BROWSER_BACKEND"] === "extension") return undefined; // extension backend chosen instead
  if (!displayAvailable()) return undefined; // launch is headful; the sign-in/CAPTCHA pause needs a visible window
  if (!(await detectChannel())) return undefined; // no real Chrome/Edge installed -> managed bundled path
  return { kind: "launch", autoClone: true };
}

/**
 * Stealth browser capture with auto-escalation. Walks the ladder; returns the first clean render immediately,
 * otherwise keeps climbing. If EVERY stealth rung still hits a wall a human must clear (CAPTCHA or sign-in) and a
 * display is available, it opens a VISIBLE max-stealth window for the user to sign in / solve it, then continues
 * in that same session. Returns the best result so the heuristic can still try; throws only if no rung launches.
 */
export class NodePlaywrightScraper implements Scraper {
  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });

    // Preferred: capture in the user's real, signed-in browser. Either explicitly configured (FORGE_BROWSER_CDP), or
    // — by default — auto-preferred when their real Chrome + a display are available. This is their real session (no
    // copy beyond a one-time clone, no profile lock, minimal bot-flagging), so we return its result directly; only a
    // hard failure to attach/drive falls through to the managed-launch stealth ladder below.
    const cdp = cdpTargetFromEnv() ?? (await autoRealChromeTarget());
    if (cdp) {
      try {
        return await captureOverCdp(url, legalMode, cdp);
      } catch (err) {
        console.error(`[urlmcp] real-browser capture (${describeCdpTarget(cdp)}) failed: ${err instanceof Error ? err.message : String(err)}; falling back to a managed browser.`);
      }
    }

    const attempts = await planBrowserAttempts();
    if (!attempts.length) throw new Error("no browser driver installed (add playwright-core, or set FORGE_BROWSER=0)");

    let best: CaptureBundle | undefined;
    let bestScore = -Infinity;
    let lastErr: unknown;
    for (const att of attempts) {
      try {
        const bundle = await captureOnce(url, legalMode, att);
        const human = needsHuman(bundle);
        if (!human && !looksBlocked(bundle)) return bundle; // genuine content — done
        const s = scoreBundle(bundle);
        if (s > bestScore) {
          best = bundle;
          bestScore = s;
        }
        // A sign-in wall won't yield to more stealth — break out to the human handoff. A CAPTCHA or a thin shell
        // still might, so keep climbing the ladder for a stronger render before considering the handoff.
        if (human && !looksBlocked(bundle)) break;
      } catch (err) {
        lastErr = err; // this rung couldn't launch (e.g. headful with no display) — try the next
      }
    }

    // Last resort: hand the wall to a human in a visible window, then continue in the same session.
    if (best && needsHuman(best) && AUTH_HANDOFF && displayAvailable()) {
      try {
        const handoff = await captureWithHumanHandoff(url, legalMode);
        if (!needsHuman(handoff)) return handoff; // they got us through
        const s = scoreBundle(handoff);
        if (s > bestScore) {
          best = handoff;
          bestScore = s;
        }
      } catch (err) {
        lastErr = err; // handoff couldn't launch — fall through to whatever we already have
      }
    } else if (best && needsHuman(best) && AUTH_HANDOFF && !displayAvailable()) {
      console.error(
        `[urlmcp] ${url} needs a human sign-in/CAPTCHA, but no display is available for the interactive handoff. ` +
          `Run on a desktop session, or point SCRAPER_URL at a scraper that can.`,
      );
    }

    if (best) return best; // blocked but rendered: better than nothing, lets the heuristic mine what it can
    throw lastErr ?? new Error(`browser capture ${url} failed`);
  }
}

function safePath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname || "/";
  } catch {
    return "/";
  }
}

/** Drop duplicate (method, templated-path) calls so an infinite-scroll page doesn't yield 50 identical tools. */
function dedupeCalls(calls: RawCall[]): RawCall[] {
  const seen = new Set<string>();
  const out: RawCall[] = [];
  for (const c of calls) {
    const key = `${c.method} ${templatePath(safePath(c.rawUrl)).urlPattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
