import { randomUUID, createHash } from "node:crypto";
import { CaptureBundle, LIMITS, scrubHeaders, type LegalMode } from "@mcp/types";
import { assertPublicHttpUrl, type Scraper } from "@mcp/generator/lean";

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
 * MCP_BROWSER_HEADLESS, FORGE_BROWSER_ESCALATE=0 (single attempt), MCP_BROWSER_TZ.
 */

const NAV_TIMEOUT_MS = Number(process.env["FORGE_BROWSER_TIMEOUT_MS"]) || 30_000;
const SETTLE_MS = Number(process.env["FORGE_BROWSER_SETTLE_MS"]) || 2_500;
const MAX_JSON_BODY = 512_000;
const INTERACT = process.env["SCRAPER_INTERACT"] !== "0";
const TIMEZONE = process.env["MCP_BROWSER_TZ"] || "America/New_York";
const VIEWPORT = { width: 1280, height: 800 };

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

interface RawCall {
  method: string;
  rawUrl: string;
  requestHeaders: Record<string, string>;
  requestBodySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  statusCode: number;
  contentType: string;
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
    console.error("[anymcp] Installing Chromium for browser capture (one-time, ~20-40s)...");
    await new Promise<void>((resolve) => {
      const child = cp.spawn(process.execPath, [cliPath, "install", "chromium"], { stdio: ["ignore", "inherit", "inherit"], timeout: 180_000 });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    console.error("[anymcp] Chromium install finished.");
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

function visibleTextLength(html: string): number {
  return html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
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
      try {
        const post = req.postData();
        if (post && post.length <= MAX_JSON_BODY && /json/i.test(String(req.headers()["content-type"] || ""))) {
          requestBodySchema = inferSchema(JSON.parse(post));
        }
      } catch {
        /* non-json body */
      }

      calls.push({
        method: String(req.method() || "GET").toUpperCase(),
        rawUrl,
        requestHeaders: scrubHeaders(req.headers() || {}),
        requestBodySchema,
        responseSchema,
        statusCode: Number(resp.status()) || 0,
        contentType,
      });
    } catch {
      /* a capture error must never break the page */
    }
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

/** Higher is better: captured API traffic dominates, then visible content; a blocked page is penalized. */
function scoreBundle(bundle: CaptureBundle): number {
  return bundle.network.length * 1000 + visibleTextLength(bundle.dom.html || "") - (looksBlocked(bundle) ? 1_000_000 : 0);
}

/** One launch+navigate+capture for a single ladder rung. Throws if the browser can't be launched for this config. */
async function captureOnce(url: string, legalMode: LegalMode, att: Attempt): Promise<CaptureBundle> {
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

  const browser = await chromium.launch({
    headless: att.headless,
    channel: att.channel,
    executablePath,
    chromiumSandbox: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: stealthArgs(att.headless),
    timeout: NAV_TIMEOUT_MS,
  });

  const calls: RawCall[] = [];
  try {
    const contextOpts: Record<string, unknown> = {
      locale: "en-US",
      timezoneId: TIMEZONE,
      viewport: att.headless ? VIEWPORT : null,
      extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    };
    const ua = uaFor(att);
    if (ua) contextOpts["userAgent"] = ua;

    const context = await browser.newContext(contextOpts);
    await context.addInitScript(stealthInit);
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    attachNetworkCapture(page, calls);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
    } catch {
      await page.waitForTimeout(SETTLE_MS).catch(() => {});
    }
    await interactionPass(page);

    let landed = url;
    try {
      landed = page.url() || url;
    } catch {
      /* ignore */
    }
    if (/^https?:\/\//i.test(landed)) await assertPublicHttpUrl(landed, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });

    const html = (await page.content()).slice(0, LIMITS.maxHtml);
    const network = dedupeCalls(calls)
      .slice(0, LIMITS.maxNetworkCalls)
      .map((c) => ({ ...templatePath(safePath(c.rawUrl)), ...c }));

    return CaptureBundle.parse({
      bundleId: randomUUID(),
      source: "scraper",
      url,
      capturedAt: new Date().toISOString(),
      legalMode,
      tier: tierFor(att),
      dom: { html, domHash: createHash("sha256").update(html).digest("hex") },
      network,
      meta: { title: extractTitle(html), robotsAllowed: true, renderedWithJs: true },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Stealth browser capture with auto-escalation. Walks the ladder; returns the first clean (non-blocked) render
 * immediately, otherwise keeps climbing and returns the best result so the heuristic can still try. Throws only
 * if EVERY rung fails to launch (the caller then falls back to the static capture).
 */
export class NodePlaywrightScraper implements Scraper {
  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    const attempts = await planBrowserAttempts();
    if (!attempts.length) throw new Error("no browser driver installed (add playwright-core, or set FORGE_BROWSER=0)");

    let best: CaptureBundle | undefined;
    let bestScore = -Infinity;
    let lastErr: unknown;
    for (const att of attempts) {
      try {
        const bundle = await captureOnce(url, legalMode, att);
        if (!looksBlocked(bundle)) return bundle; // clean render — done
        const s = scoreBundle(bundle);
        if (s > bestScore) {
          best = bundle;
          bestScore = s;
        }
      } catch (err) {
        lastErr = err; // this rung couldn't launch (e.g. headful with no display) — try the next
      }
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
