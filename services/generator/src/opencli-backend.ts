/**
 * OpenCLI browser backend for generated servers: an alternative to PlaywrightBrowsing that drives the user's
 * real logged-in Chrome via opencli's Browser Bridge (for JS-only SPAs / bot-hardened sites a headless Chromium
 * can't render). Emits an OpenCliBrowsing class (mapping the Browsing surface onto `opencli browser <s> <cmd>`)
 * + a createBrowsing() factory that picks the backend at runtime.
 */

import { BOT_MARKERS } from "./browser-gate.js";

export type BrowserBackend = "playwright" | "opencli";

export interface DynamicSiteSignals {
  /** The capture rendered client-side JS (a real browser was used). */
  renderedWithJs?: boolean;
  /** Length of the visible text after render - a JS-only shell renders almost nothing statically. */
  renderedTextLength?: number;
  /** An anti-bot wall / challenge was detected in the captured HTML (high precision; reuses BOT_MARKERS). */
  botWalled?: boolean;
  /** The captured HTML is an explicit un-rendered SPA shell ("enable JavaScript" + an app-root mount). */
  spaShell?: boolean;
  /** Count of candidate API endpoints captured (HTTP tools can be wired only when > 0). */
  networkApiCount?: number;
}

/**
 * Default browser backend for a generated server. Precision-first: route to opencli only on high-confidence
 * signals (it's the baked default, degraded back to Playwright at runtime when the bridge is down).
 */
export function chooseBrowserBackend(s: DynamicSiteSignals): BrowserBackend {
  if (s.botWalled === true) return "opencli"; // an anti-bot wall in the capture: a headless fetch can't get past it
  const noApiToWire = (s.networkApiCount ?? 0) === 0;
  if (s.spaShell === true && noApiToWire) return "opencli"; // an explicit JS-only shell with nothing to wire
  return "playwright";
}

// An app-mount root a SPA hydrates into; paired with a "needs JS" notice = a high-precision empty-shell signal.
const SPA_MOUNT_RE = /<(?:div|main|section)[^>]+id=["'](?:root|app|__next|app-root|__nuxt|svelte|application)["']/i;
const NEEDS_JS_RE = /\b(?:enable javascript|you need to enable javascript|please enable javascript|requires javascript)\b/i;

/** Rough visible-text length: drop scripts/styles/tags, collapse whitespace. Cheap, good enough for signals. */
function visibleTextLength(html: string): number {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Derive routing signals from a capture bundle - the single place call sites compute backend routing.
 * networkApiCount counts real captured endpoints (bundle.network), not inferred tools.
 */
export function deriveDynamicSignals(
  bundle: { dom?: { html?: string }; meta?: { renderedWithJs?: boolean }; network?: ReadonlyArray<unknown> } | undefined,
): DynamicSiteSignals {
  const html = bundle?.dom?.html ?? "";
  const hay = html.toLowerCase();
  const botWalled = BOT_MARKERS.some((m) => hay.indexOf(m) !== -1);
  const spaShell = NEEDS_JS_RE.test(html) && SPA_MOUNT_RE.test(html) && visibleTextLength(html) < 600;
  const networkApiCount = Array.isArray(bundle?.network) ? bundle.network.length : 0;
  return {
    renderedWithJs: bundle?.meta?.renderedWithJs === true,
    renderedTextLength: visibleTextLength(html),
    botWalled,
    spaShell,
    networkApiCount,
  };
}

/**
 * Emit the OpenCliBrowsing class + the createBrowsing() factory + the DEFAULT_BROWSER_BACKEND constant as source
 * text for the generated server. `slug` seeds the default opencli session name; `defaultBackend` is baked from
 * the generate-time detection (chooseBrowserBackend) and is always overridable at runtime via MCP_BROWSER_BACKEND.
 */
export function emitOpenCliBrowsingRuntime(slug: string, defaultBackend: BrowserBackend): string {
  const sessionDefault = JSON.stringify("mcp-" + (slug || "site"));
  const backendLiteral = JSON.stringify(defaultBackend === "opencli" ? "opencli" : "playwright");
  return `// --- OpenCLI backend: drive the user's REAL logged-in Chrome via the opencli Browser Bridge ---
// Maps the same Browsing surface as PlaywrightBrowsing onto \`opencli browser <session> <cmd>\` (verified
// against opencli v1.8.2). Used for dynamic / bot-walled sites where a headless Chromium is blocked or blind.
let OPENCLI_BIN_CACHE: string | undefined;
// Resolve the opencli CLI: explicit env first, then this server's own dependency (node_modules/.bin/opencli,
// installed because dynamicBackend==="opencli" adds it to package.json), then a global opencli on PATH.
async function resolveOpencliBin(): Promise<string> {
  if (OPENCLI_BIN_CACHE) return OPENCLI_BIN_CACHE;
  if (process.env.MCP_OPENCLI_BIN) { OPENCLI_BIN_CACHE = process.env.MCP_OPENCLI_BIN; return OPENCLI_BIN_CACHE; }
  try {
    const fs: any = await import("node:fs");
    const url: any = await import("node:url");
    const local = url.fileURLToPath(new URL("./node_modules/.bin/opencli", import.meta.url));
    if (fs.existsSync(local)) { OPENCLI_BIN_CACHE = local; return local; }
  } catch { /* fall through to a global opencli */ }
  OPENCLI_BIN_CACHE = "opencli";
  return OPENCLI_BIN_CACHE;
}
const OPENCLI_SESSION = process.env.MCP_OPENCLI_SESSION || ${sessionDefault};
const OPENCLI_TIMEOUT_MS = Number(process.env.MCP_OPENCLI_TIMEOUT_MS || 60_000);
const OPENCLI_HINT =
  " (is the opencli Browser Bridge connected? run \\"opencli doctor\\", and in Chrome \\"opencli browser " +
  OPENCLI_SESSION + " bind\\" the tab you want to drive)";

class OpenCliBrowsing implements Browsing {
  private stepExecutor?: StepExecutor;
  private opened = false;
  constructor(stepExecutor?: StepExecutor) { this.stepExecutor = stepExecutor; }

  // Shell out to one opencli browser subcommand and return its stdout. Dynamic-imports node:child_process the
  // same indirect way importBrowserDriver loads playwright, so no extra top-level import is added to the server.
  private async run(args: string[]): Promise<string> {
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    const cp: any = await dynamicImport("node:child_process");
    const bin = await resolveOpencliBin();
    const full: string[] = ["browser", OPENCLI_SESSION].concat(args);
    return new Promise<string>((resolve, reject) => {
      cp.execFile(bin, full, { maxBuffer: 8_000_000, timeout: OPENCLI_TIMEOUT_MS }, (err: any, stdout: any, stderr: any) => {
        if (err) {
          const detail = String((stderr && String(stderr).trim()) || (err && err.message) || err);
          reject(new Error("opencli browser " + String(args[0]) + " failed: " + detail + OPENCLI_HINT));
          return;
        }
        resolve(String(stdout == null ? "" : stdout));
      });
    });
  }

  // Is the opencli CLI present AND the Browser Bridge connected? Used by AutoBrowsing to decide whether a BAKED
  // opencli default is usable before committing to it (a missing CLI / disconnected bridge => fall back). Cheap
  // and never throws: a missing binary or a non-connected doctor both return false.
  async healthcheck(): Promise<boolean> {
    try {
      const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
      const cp: any = await dynamicImport("node:child_process");
      const bin = await resolveOpencliBin();
      return await new Promise<boolean>((resolve) => {
        cp.execFile(bin, ["doctor"], { timeout: 15_000 }, (err: any, stdout: any, stderr: any) => {
          const out = String((stdout == null ? "" : stdout)) + String((stderr == null ? "" : stderr));
          // Positive doctor lines are "Extension: connected" / "Connectivity: connected" - which do NOT match
          // the negative "Extension: not connected". A spawn error (ENOENT/no opencli) leaves out empty => false.
          resolve(/(?:Extension|Connectivity):\\s*connected/i.test(out));
        });
      });
    } catch { return false; }
  }

  // Open the source site once on first use so relative navigation + the first snapshot have a page.
  private async ensureOpen(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    if (SITE_URL) { try { await this.run(["open", SITE_URL]); } catch { /* state still works on a bound tab */ } }
  }

  // opencli's \`state\` already prints URL + title + interactive elements with [N] indices; pass it through
  // verbatim so the model reads [N] and calls browser_click/type with that same ref. No reformatting = no drift.
  private async snapshotText(): Promise<string> { return this.run(["state"]); }

  async navigate(url: string): Promise<string> {
    await this.ensureOpen();
    let target = url;
    try { target = /^https?:/i.test(url) ? url : new URL(url, SITE_URL || undefined).toString(); } catch { /* use raw */ }
    await this.run(["open", target]);
    try { await this.run(["eval", DISMISS_SCRIPT]); } catch { /* best-effort consent dismissal */ }
    return this.snapshotText();
  }

  async snapshot(): Promise<string> { await this.ensureOpen(); return this.snapshotText(); }

  // Run the SAME curated consent-dismissal script PlaywrightBrowsing uses, via opencli eval (no throw).
  async dismiss(): Promise<string> {
    await this.ensureOpen();
    try { await this.run(["eval", DISMISS_SCRIPT]); } catch { /* best-effort */ }
    return this.snapshotText();
  }

  async click(ref: string): Promise<string> { await this.ensureOpen(); await this.run(["click", String(ref)]); return this.snapshotText(); }

  async type(ref: string, text: string, submit?: boolean): Promise<string> {
    await this.ensureOpen();
    await this.run(["type", String(ref), String(text)]);
    if (submit) await this.run(["keys", "Enter"]);
    return this.snapshotText();
  }

  async pressKey(key: string, ref?: string): Promise<string> {
    await this.ensureOpen();
    if (ref) { try { await this.run(["focus", String(ref)]); } catch { /* best-effort focus */ } }
    await this.run(["keys", String(key)]);
    return this.snapshotText();
  }

  async selectOption(ref: string, value: string): Promise<string> {
    await this.ensureOpen();
    await this.run(["select", String(ref), String(value)]);
    return this.snapshotText();
  }

  async back(): Promise<string> { await this.ensureOpen(); try { await this.run(["back"]); } catch { /* nothing to go back to */ } return this.snapshotText(); }

  async read(): Promise<string> { await this.ensureOpen(); return this.run(["extract"]); }

  async extract(mode: string): Promise<unknown> {
    await this.ensureOpen();
    const content = await this.run(["extract"]);
    return { mode: String(mode || "metadata"), content };
  }

  // Inferred browser-step tools. opencli's click/type/select/fill accept a CSS selector target directly, so the
  // selector-based steps map straight across; waitFor uses \`wait selector\`/\`wait time <seconds>\`.
  async runSteps(spec: BrowserToolSpec, args: Record<string, unknown>): Promise<unknown> {
    if (this.stepExecutor) return this.stepExecutor(spec, args);
    await this.ensureOpen();
    let extracted: unknown;
    for (const step of spec.steps) {
      if (step.action === "navigate") {
        if (templateMissingPathParam(step.value, args)) continue;
        await this.run(["open", interpolateUrl(step.value, args, SITE_URL)]);
      } else if (step.action === "waitFor") {
        const sel = step.target && step.target.selector;
        if (sel) { try { await this.run(["wait", "selector", sel]); } catch { /* best-effort */ } }
        else { const secs = Math.max(1, Math.round(Number(step.value || 300) / 1000)); try { await this.run(["wait", "time", String(secs)]); } catch { /* best-effort */ } }
      } else if (step.action === "fill") {
        const sel = step.target && step.target.selector;
        if (!sel) throw new Error("browser fill step requires a selector");
        await this.run(["fill", sel, interpolate(step.value, args)]);
      } else if (step.action === "click") {
        const sel = step.target && step.target.selector;
        if (!sel) throw new Error("browser click step requires a selector");
        await this.run(["click", sel]);
      } else if (step.action === "selectOption") {
        const sel = step.target && step.target.selector;
        if (!sel) throw new Error("browser selectOption step requires a selector");
        await this.run(["select", sel, interpolate(step.value, args)]);
      } else if (step.action === "pressKey") {
        const value = interpolate(step.value, args);
        if (!value) throw new Error("browser pressKey step requires a key");
        const sel = step.target && step.target.selector;
        if (sel) { try { await this.run(["focus", sel]); } catch { /* best-effort */ } }
        await this.run(["keys", value]);
      } else if (step.action === "extract") {
        const sel = step.target && step.target.selector;
        const mode = String(step.value || "");
        if (sel && /listing|list|cards?/.test(mode)) {
          // One record PER card: opencli \`find --css\` returns {entries:[{text,ref,tag}]} for every match,
          // mirroring json:listing (whereas \`extract --selector\` returns only the first matched region).
          const raw = await this.run(["find", "--css", sel, "--limit", "100", "--text-max", "400"]);
          try {
            const parsed: any = JSON.parse(raw);
            const entries: any[] = (parsed && parsed.entries) || [];
            extracted = entries.map((e: any) => ({ text: String((e && e.text) || "").trim(), ref: e && e.ref, tag: e && e.tag }));
          } catch { extracted = raw; }
        } else {
          extracted = await this.run(sel ? ["extract", "--selector", sel] : ["extract"]);
        }
      }
    }
    if (extracted === undefined) extracted = await this.run(["extract"]);
    return extracted;
  }

  // With the real browser the human is already present, so a sign-in/CAPTCHA just gets solved in-place; resume
  // simply re-observes the page.
  async resume(): Promise<unknown> { return this.snapshot(); }

  async close(): Promise<void> { if (!this.opened) return; this.opened = false; try { await this.run(["close"]); } catch { /* lease already gone */ } }
}

// Per-server default backend (baked from generate-time dynamic-site detection); MCP_BROWSER_BACKEND overrides
// it at runtime, so any generated browser server can be flipped to the real-Chrome backend without regen.
// Degradable wrapper for a BAKED opencli default. The site was auto-detected as dynamic, but the user never
// asked for opencli - so if its CLI/bridge is unreachable we must NOT hard-fail every tool call. On first use
// we healthcheck opencli once; if it is usable we drive it, otherwise we transparently fall back to the
// standalone Playwright backend. (Explicit MCP_BROWSER_BACKEND=opencli skips this and stays strict, so a user
// who asked for opencli still gets the actionable bridge error.) Each method is a one-line delegate.
class AutoBrowsing implements Browsing {
  private stepExecutor?: StepExecutor;
  private impl?: Browsing;
  constructor(stepExecutor?: StepExecutor) { this.stepExecutor = stepExecutor; }
  private async backend(): Promise<Browsing> {
    if (this.impl) return this.impl;
    const oc = new OpenCliBrowsing(this.stepExecutor);
    const ok = await oc.healthcheck();
    if (ok) { this.impl = oc; }
    else {
      console.error("[mcp] browser backend 'opencli' (auto-detected) is unreachable - the opencli Browser Bridge is not connected. Falling back to the Playwright backend. Run the bridge and set MCP_BROWSER_BACKEND=opencli to force it." + OPENCLI_HINT);
      this.impl = new PlaywrightBrowsing(this.stepExecutor);
    }
    return this.impl;
  }
  async runSteps(spec: BrowserToolSpec, args: Record<string, unknown>): Promise<unknown> { return (await this.backend()).runSteps(spec, args); }
  async navigate(url: string): Promise<string> { return (await this.backend()).navigate(url); }
  async snapshot(): Promise<string> { return (await this.backend()).snapshot(); }
  async click(ref: string): Promise<string> { return (await this.backend()).click(ref); }
  async type(ref: string, text: string, submit?: boolean): Promise<string> { return (await this.backend()).type(ref, text, submit); }
  async pressKey(key: string, ref?: string): Promise<string> { return (await this.backend()).pressKey(key, ref); }
  async selectOption(ref: string, value: string): Promise<string> { return (await this.backend()).selectOption(ref, value); }
  async back(): Promise<string> { return (await this.backend()).back(); }
  async read(): Promise<string> { return (await this.backend()).read(); }
  async extract(mode: string): Promise<unknown> { return (await this.backend()).extract(mode); }
  async dismiss(): Promise<string> { const b = await this.backend(); return b.dismiss ? b.dismiss() : b.snapshot(); }
  async resume(): Promise<unknown> { const b = await this.backend(); return b.resume ? b.resume() : b.snapshot(); }
  async close(): Promise<void> { if (this.impl && this.impl.close) return this.impl.close(); }
}

// Per-server default backend (baked from generate-time dynamic-site detection); MCP_BROWSER_BACKEND overrides
// it at runtime, so any generated browser server can be flipped to the real-Chrome backend without regen.
const DEFAULT_BROWSER_BACKEND: string = ${backendLiteral};
function createBrowsing(stepExecutor?: StepExecutor): Browsing {
  const env = String(process.env.MCP_BROWSER_BACKEND || "").toLowerCase();
  // Explicit user choice is honored strictly (opencli => actionable bridge error if down; never silent fallback).
  if (env === "opencli") return new OpenCliBrowsing(stepExecutor);
  if (env === "playwright") return new PlaywrightBrowsing(stepExecutor);
  // No explicit choice: a baked opencli default is DEGRADABLE (falls back to Playwright when the bridge is down).
  if (DEFAULT_BROWSER_BACKEND === "opencli") return new AutoBrowsing(stepExecutor);
  return new PlaywrightBrowsing(stepExecutor);
}
`;
}
