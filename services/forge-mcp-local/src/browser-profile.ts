import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { forgeHome } from "./persistence.js";

/**
 * Real-profile login reuse for browser capture.
 *
 * By default each capture launches a fresh, empty browser profile, so the user is signed into nothing. When
 * FORGE_BROWSER_PROFILE is set, capture instead launches the SAME Chrome/Edge binary against the user's real
 * profile, so the window opens already signed into their Gmail / Google / everything else they're logged into.
 *
 * Two modes (plus an explicit-path escape hatch):
 *   - "clone" (recommended default once opted in): copy the user's real profile ONCE into a forge-owned dir
 *     (~/.urlmcp/browser-profile/<channel>) and drive that. Their everyday Chrome keeps working untouched and
 *     stays unlocked. Cookies still decrypt because it's the same OS user + same browser binary (Chrome's
 *     os_crypt key, carried in the copied "Local State", is unwrapped per-OS-user, not per-profile-path).
 *   - "real": drive the user's actual profile dir in place. Gives every login with zero copy, but Chrome LOCKS a
 *     profile while it's open — the user must fully quit Chrome first — and automation touches their live profile.
 *   - an absolute path: treat it as the user-data-dir to launch against (advanced).
 *
 * Env:
 *   FORGE_BROWSER_PROFILE         off (default) | clone | real | <abs user-data-dir path>
 *   FORGE_BROWSER_PROFILE_NAME    which profile dir inside User Data (default "Default"; e.g. "Profile 1")
 *   FORGE_BROWSER_PROFILE_SRC     override the source "User Data" dir (default: the OS Chrome/Edge location)
 *   FORGE_BROWSER_PROFILE_REFRESH 1 to re-copy the clone from the live profile (otherwise cloned once and reused)
 *
 * NOTE: signing a profile into Google and then driving it with automation can trip Google's account-security
 * checks. The clone keeps that risk off the user's primary profile, but it's still the same account — surfaced to
 * the user in server output, not hidden here.
 */

export interface ResolvedProfile {
  /** user-data-dir to hand to launchPersistentContext. */
  userDataDir: string;
  /** Profile sub-directory to select via --profile-directory. */
  profileDirectory: string;
  /** "clone" | "real" | "path" — for logging only. */
  mode: string;
}

const OFF = new Set(["", "0", "off", "false", "no"]);

// Clone dirs already refreshed in THIS process, so FORGE_BROWSER_PROFILE_REFRESH re-copies once per run — not on
// every capture (a multi-page crawl calls resolveProfile per page, and re-cloning a dir an attached browser is
// using would corrupt the live session).
const refreshedDests = new Set<string>();

/** The OS default "User Data" dir for a Playwright channel ("chrome"/"msedge"). Undefined for unknown channels. */
export function defaultUserDataDir(channel: string | undefined): string | undefined {
  const home = homedir();
  const isEdge = channel === "msedge";
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return isEdge ? join(base, "Microsoft Edge") : join(base, "Google", "Chrome");
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    return isEdge ? join(local, "Microsoft", "Edge", "User Data") : join(local, "Google", "Chrome", "User Data");
  }
  // linux / other
  return isEdge ? join(home, ".config", "microsoft-edge") : join(home, ".config", "google-chrome");
}

// Heavy or lock/socket files that must NOT be copied into the clone: caches bloat the copy and add nothing to the
// session; Singleton*/.lock are live-instance locks that would make the clone look "already running".
const SKIP_SEGMENTS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "Crashpad",
  "Crash Reports",
  "component_crx_cache",
  "extensions_crx_cache",
  "CacheStorage",
  "ScriptCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
]);

function copyFilter(src: string): boolean {
  const base = src.split(/[\\/]/).pop() || "";
  if (SKIP_SEGMENTS.has(base)) return false;
  if (base.startsWith("Singleton")) return false; // SingletonLock / SingletonSocket / SingletonCookie
  if (base.endsWith(".lock")) return false;
  return true;
}

/**
 * Copy the user's real profile into a forge-owned dir, skipping caches and live-instance locks. Only the chosen
 * profile sub-dir + top-level "Local State" (which holds the os_crypt key wrapper) are copied — enough to carry
 * cookies and logged-in sessions, without the multi-GB cache tree.
 */
export function cloneProfile(srcUserData: string, destUserData: string, profileName: string): void {
  const srcProfile = join(srcUserData, profileName);
  if (!existsSync(srcProfile)) {
    throw new Error(
      `browser profile "${profileName}" not found at ${srcProfile} — is Chrome/Edge installed and signed in? ` +
        `Set FORGE_BROWSER_PROFILE_NAME / FORGE_BROWSER_PROFILE_SRC to point at the right one.`,
    );
  }
  mkdirSync(destUserData, { recursive: true });
  const localState = join(srcUserData, "Local State");
  if (existsSync(localState)) cpSync(localState, join(destUserData, "Local State"));
  cpSync(srcProfile, join(destUserData, profileName), { recursive: true, filter: copyFilter });
}

/**
 * Resolve the profile to launch against, given the detected channel. Returns undefined when profile reuse is off
 * (the normal fresh-profile path) OR when it can't be applied safely (e.g. no real channel and not forced). When
 * "clone" is requested the copy is made on first use and reused thereafter (FORGE_BROWSER_PROFILE_REFRESH=1 re-copies).
 */
export function resolveProfile(
  channel: string | undefined,
  log: (m: string) => void = () => {},
  opts?: { defaultMode?: "clone" | "real" },
): ResolvedProfile | undefined {
  // When FORGE_BROWSER_PROFILE is UNSET and the caller supplies a defaultMode (the auto "use the person's Chrome"
  // path), behave as that mode so the launched browser is signed in — but an explicit "off"/"0" still wins.
  let raw = (process.env["FORGE_BROWSER_PROFILE"] || "").trim();
  if (!raw && opts?.defaultMode) raw = opts.defaultMode;
  if (OFF.has(raw.toLowerCase())) return undefined;

  const profileName = process.env["FORGE_BROWSER_PROFILE_NAME"]?.trim() || "Default";

  // Explicit absolute path: drive it directly, no copy.
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    if (!existsSync(raw)) throw new Error(`FORGE_BROWSER_PROFILE path does not exist: ${raw}`);
    return { userDataDir: raw, profileDirectory: profileName, mode: "path" };
  }

  const mode = raw.toLowerCase();
  // The real profile was created by the user's real Chrome/Edge; only drive it with that same channel (a bundled
  // Chromium can refuse a profile from a newer build, or rewrite it). Skip silently when no channel is detected.
  if (!channel) {
    log(
      "[urlmcp] FORGE_BROWSER_PROFILE is set but no real Chrome/Edge was detected to open it with; " +
        "using a fresh profile. Install Chrome/Edge, or set MCP_BROWSER_CHANNEL.",
    );
    return undefined;
  }

  const src = process.env["FORGE_BROWSER_PROFILE_SRC"]?.trim() || defaultUserDataDir(channel);
  if (!src || !existsSync(src)) {
    log(`[urlmcp] FORGE_BROWSER_PROFILE: no ${channel} "User Data" dir found (${src ?? "unknown"}); using a fresh profile.`);
    return undefined;
  }

  if (mode === "real") {
    log(
      `[urlmcp] Driving your REAL ${channel} profile in place (${join(src, profileName)}). ` +
        "Close Chrome/Edge first if it's open, or the profile will be locked.",
    );
    return { userDataDir: src, profileDirectory: profileName, mode: "real" };
  }

  // mode is "clone" / "1" / "on" / "auto" / anything else truthy -> clone-and-drive.
  const dest = join(forgeHome(), "browser-profile", channel);
  const clonedProfile = join(dest, profileName);
  // Refresh re-copies current cookies, but only ONCE per process: a multi-page crawl calls resolveProfile per page,
  // and re-cloning a dir the attached browser is actively using would wipe the live (logged-in) session mid-run.
  const refresh = process.env["FORGE_BROWSER_PROFILE_REFRESH"] === "1" && !refreshedDests.has(dest);
  if (refresh && existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* best-effort refresh */
    }
  }
  if (process.env["FORGE_BROWSER_PROFILE_REFRESH"] === "1") refreshedDests.add(dest);
  if (!existsSync(clonedProfile)) {
    log(`[urlmcp] Cloning your ${channel} profile "${profileName}" so capture opens already signed in (one-time)...`);
    cloneProfile(src, dest, profileName);
    log("[urlmcp] Profile clone ready.");
  }
  return { userDataDir: dest, profileDirectory: profileName, mode: "clone" };
}
