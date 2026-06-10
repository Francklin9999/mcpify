import { randomUUID, createHash } from "node:crypto";
import { CaptureBundle, LIMITS, scrubHeaders, type LegalMode } from "@mcp/types";
import { assertPublicHttpUrl, type Scraper } from "@mcp/generator/lean";

/**
 * In-process stealth browser capture for the standalone server: renders JS and captures XHR/fetch traffic
 * (via CDP) so the standalone can build tools from dynamic / bot-walled sites without the Python backend.
 * Playwright is lazy-loaded, so the static path still works when it isn't installed. Stealth mirrors the
 * generated servers: AutomationControlled off, navigator.webdriver stripped, optional real Chrome channel /
 * stealth-patched driver (MCP_BROWSER_DRIVER=patchright|rebrowser-playwright, MCP_BROWSER_CHANNEL=chrome).
 */

const NAV_TIMEOUT_MS = Number(process.env["FORGE_BROWSER_TIMEOUT_MS"]) || 30_000;
const SETTLE_MS = Number(process.env["FORGE_BROWSER_SETTLE_MS"]) || 2_500;
const MAX_JSON_BODY = 512_000;
const INTERACT = process.env["SCRAPER_INTERACT"] !== "0";

interface RawCall {
  method: string;
  rawUrl: string;
  requestHeaders: Record<string, string>;
  requestBodySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  statusCode: number;
  contentType: string;
}

const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

/** Lazy-load Chromium: a stealth-patched driver if requested, else playwright-core (lean, no auto-download)
 *  or full playwright. Null when none is installed. */
async function importChromium(): Promise<any | null> {
  const preferred = process.env["MCP_BROWSER_DRIVER"];
  for (const mod of [preferred, "playwright-core", "playwright"]) {
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

let installAttempted = false;
/**
 * Ensure a Chromium binary exists, installing it ONCE on first use (playwright-core ships no browser binary,
 * so the npm install stays tiny). Best-effort + bounded; FORGE_NO_BROWSER_INSTALL=1 opts out. Progress goes to
 * stderr (the MCP client's logs) since the first install takes ~20-40s.
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

/** Whether a browser capture is possible here (playwright installed + a launchable Chromium). Cheap, cached. */
let availableCache: boolean | undefined;
export async function playwrightAvailable(): Promise<boolean> {
  if (process.env["FORGE_BROWSER"] === "0") return false; // config toggle, not cached
  if (availableCache !== undefined) return availableCache;
  const chromium = await importChromium();
  if (!chromium) return (availableCache = false); // playwright-core not installed -> static-only
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

/** Stealth browser capture producing a CaptureBundle with rendered DOM + captured XHR/fetch (tier 2). */
export class NodePlaywrightScraper implements Scraper {
  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    const chromium = await importChromium();
    if (!chromium) throw new Error("playwright-core is not installed (add it, or set FORGE_BROWSER=0 for static-only)");
    await ensureChromiumInstalled(chromium); // first-run binary fetch if a probe didn't already do it

    const channel = process.env["MCP_BROWSER_CHANNEL"] || undefined;
    const executablePath = process.env["MCP_BROWSER_PATH"] || undefined;
    const headless = process.env["MCP_BROWSER_HEADLESS"] !== "0";
    const browser = await chromium.launch({
      headless,
      channel,
      executablePath,
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      timeout: NAV_TIMEOUT_MS,
    });

    const calls: RawCall[] = [];
    try {
      const context = await browser.newContext({ userAgent: undefined });
      await context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        } catch {
          /* ignore */
        }
      });
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
        tier: 2,
        dom: { html, domHash: createHash("sha256").update(html).digest("hex") },
        network,
        meta: { title: extractTitle(html), robotsAllowed: true, renderedWithJs: true },
      });
    } finally {
      await browser.close().catch(() => {});
    }
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
