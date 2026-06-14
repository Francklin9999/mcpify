import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { forgeHome } from "./persistence.js";
import { resolveProfile } from "./browser-profile.js";

/**
 * Attach to a browser the user is ALREADY running, over the Chrome DevTools Protocol, instead of launching a
 * fresh throwaway Chromium. The point: drive the user's real, already-signed-in session (Gmail / LinkedIn / X /
 * everything) the same way hanzi-browse/comet-mcp do — no profile copy, no profile lock, and far less bot-flagging
 * than a Playwright-spawned Chromium, because it IS the real browser.
 *
 * Two shapes, both via `FORGE_BROWSER_CDP`:
 *   - an ENDPOINT — attach to a CDP server the user (or another tool: their own Chrome started with
 *     `--remote-debugging-port`, Comet, browseros, etc.) already exposed. Accepts `9222`, `host:9222`,
 *     `http://127.0.0.1:9222`, or a raw `ws://`/`wss://` DevTools URL.
 *   - `launch` — urlmcp starts the user's REAL Chrome/Edge binary with a debugging port against a urlmcp-owned
 *     user-data-dir and attaches to it, leaving it open for the user. Pair with `FORGE_BROWSER_PROFILE=clone` so
 *     that launched browser is already signed into their accounts (the clone carries their cookies); on its own it
 *     starts from a fresh, persistent dir so logins the user does there stick across runs.
 *
 * Why a dedicated dir for `launch` instead of their live profile: Chrome only honors `--remote-debugging-port` for
 * the FIRST process that owns a user-data-dir. If their everyday Chrome is already running on the Default profile,
 * a second `chrome --remote-debugging-port` just hands the URL to that instance and the port never opens. A
 * separate dir (the clone, or a fresh persistent one) sidesteps that — and leaves their everyday Chrome untouched.
 */

const OFF = new Set(["", "0", "off", "false", "no"]);
const LAUNCH = new Set(["1", "on", "true", "yes", "auto", "launch"]);

export type CdpTarget = { kind: "endpoint"; endpoint: string } | { kind: "launch"; autoClone?: boolean };

/** Normalize a host[:port] / port / url string into an http(s)/ws(s) CDP endpoint, or undefined if it isn't one. */
function normalizeEndpoint(raw: string): string | undefined {
  const s = raw.trim();
  if (/^(?:wss?|https?):\/\//i.test(s)) {
    try {
      return new URL(s).hostname ? s : undefined; // reject scheme-only junk like "http://" (no host)
    } catch {
      return undefined;
    }
  }
  if (/^\d{2,5}$/.test(s)) return `http://127.0.0.1:${s}`;
  if (/^[\w.-]+:\d{2,5}$/.test(s)) return `http://${s}`;
  return undefined;
}

/** Parse FORGE_BROWSER_CDP into a target, or undefined when CDP attach is off (the default). */
export function cdpTargetFromEnv(env: NodeJS.ProcessEnv = process.env): CdpTarget | undefined {
  const raw = (env["FORGE_BROWSER_CDP"] || "").trim();
  if (OFF.has(raw.toLowerCase())) return undefined;
  if (LAUNCH.has(raw.toLowerCase())) return { kind: "launch" };
  const endpoint = normalizeEndpoint(raw);
  return endpoint ? { kind: "endpoint", endpoint } : undefined;
}

export function describeCdpTarget(t: CdpTarget): string {
  return t.kind === "launch" ? "launch (real Chrome + debugging port)" : `attach ${t.endpoint}`;
}

// Known real-browser executables per OS (kept in step with detectChannel() in playwright-scraper.ts).
const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
};
const EDGE_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  win32: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
  linux: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
};

/** The real Chrome/Edge executable to launch for `launch` mode: MCP_BROWSER_PATH wins, else a known install. */
function realBrowserExecutable(): { exe: string; channel: string } | undefined {
  const forced = process.env["MCP_BROWSER_PATH"];
  if (forced && existsSync(forced)) return { exe: forced, channel: process.env["MCP_BROWSER_CHANNEL"] || "chrome" };
  const wantEdge = process.env["MCP_BROWSER_CHANNEL"] === "msedge";
  const order = wantEdge ? [EDGE_PATHS, CHROME_PATHS] : [CHROME_PATHS, EDGE_PATHS];
  for (const table of order) {
    const list = table[process.platform] || table["linux"] || [];
    for (const p of list) if (existsSync(p)) return { exe: p, channel: table === EDGE_PATHS ? "msedge" : "chrome" };
  }
  return undefined;
}

/** Poll the CDP `/json/version` endpoint until the just-launched browser is accepting connections, or time out. */
async function waitForCdp(endpoint: string, deadline: number): Promise<void> {
  const base = endpoint.replace(/\/$/, "");
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CDP endpoint ${endpoint} did not come up in time${lastErr ? `: ${String(lastErr)}` : ""}`);
}

/**
 * Launch the user's real Chrome/Edge with a debugging port and return the endpoint to attach to. Reuses the cloned
 * signed-in profile when FORGE_BROWSER_PROFILE is set (so the launched browser is logged in), else a dedicated
 * persistent dir under the urlmcp home. Best-effort: throws if no real browser is installed (caller falls back).
 */
async function launchRealBrowserCdp(log: (m: string) => void, autoClone = false): Promise<string> {
  const found = realBrowserExecutable();
  if (!found) throw new Error("no real Chrome/Edge found to launch for FORGE_BROWSER_CDP=launch (set MCP_BROWSER_PATH)");
  const port = Number(process.env["FORGE_BROWSER_CDP_PORT"]) || 47_800;
  const endpoint = `http://127.0.0.1:${port}`;

  // Idempotent FIRST: if a previous `launch` is still serving CDP on this port (e.g. an earlier page of a crawl),
  // reattach to it — BEFORE touching the profile, so we never re-clone or re-launch into a session already in use.
  try {
    await waitForCdp(endpoint, Date.now() + 800);
    log(`[urlmcp] Reattaching to the ${found.channel} already running on ${endpoint}.`);
    return endpoint;
  } catch {
    /* nothing there yet — clone (if needed) + launch one below */
  }

  // Prefer a signed-in clone when the user opted into profile reuse — or when this is the auto path (autoClone),
  // which defaults to cloning their signed-in profile so the launched browser is already logged in. Otherwise a
  // dedicated, persistent dir so logins they do in the launched window survive. Never the live everyday profile
  // (the debug port wouldn't open while their normal Chrome owns it).
  const profile = resolveProfile(found.channel, log, autoClone ? { defaultMode: "clone" } : undefined);
  const userDataDir = profile?.userDataDir || join(forgeHome(), "cdp-profile", found.channel);
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (profile) args.push(`--profile-directory=${profile.profileDirectory}`);

  log(`[urlmcp] Launching your real ${found.channel} with a debugging port (${userDataDir})...`);
  const child = spawn(found.exe, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();

  await waitForCdp(endpoint, Date.now() + 15_000);
  log(`[urlmcp] Real ${found.channel} is up on ${endpoint} — attaching.`);
  return endpoint;
}

/** Resolve a target to a concrete CDP endpoint string, launching the real browser first when kind === "launch". */
export async function resolveCdpEndpoint(target: CdpTarget, log: (m: string) => void = () => {}): Promise<string> {
  if (target.kind === "endpoint") return target.endpoint;
  return launchRealBrowserCdp(log, target.autoClone);
}
