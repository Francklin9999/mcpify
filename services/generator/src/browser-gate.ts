/**
 * Gate detection for the generated server's persistent browser session.
 *
 * A "gate" is a point where an automated browser tool can't proceed without a human: an anti-bot CAPTCHA
 * challenge, or a sign-in wall. This module is the SINGLE SOURCE OF TRUTH for that decision: the pure
 * `classifyGate` + its marker tables are unit-tested here, and `emitGateRuntime()` serializes them
 * byte-for-byte into the generated `server.ts` (constants via JSON, functions via Function.toString), so the
 * shipped runtime and the tested logic can never drift. Nothing here imports anything (it has to survive
 * being lifted into a standalone, dependency-free server).
 */

export type GateKind = "ok" | "auth" | "captcha";

export interface GateSignals {
  /** The URL the action asked for (navigate target / tool URL). Absent for click/snapshot. */
  requestedUrl?: string;
  /** The URL we actually landed on after the action settled. */
  landedUrl?: string;
  title?: string;
  /** A visible-text excerpt of the landed page (caller slices it). */
  text?: string;
  /** A visible password field is present on the page. */
  hasPasswordField?: boolean;
  /** A known anti-bot challenge widget (reCAPTCHA / hCaptcha / Turnstile / PerimeterX / Cloudflare) is present. */
  hasChallengeFrame?: boolean;
}

export interface GateResult {
  kind: GateKind;
  reason: string;
}

// Anti-bot challenge text markers. Ported VERBATIM from the scraper's tuned set (services/scraper/scraper/
// capture.py `_BOT_MARKERS`) so the runtime escalation and the capture-time escalation agree on what a
// bot-wall looks like. Conservative on purpose - a false "captcha" pauses the agent for no reason.
export const BOT_MARKERS: string[] = [
  "captcha",
  "enter the characters you see",
  "automated access",
  "api-services-support@amazon",
  "unusual traffic",
  "/cdn-cgi/challenge-platform",
  "just a moment...",
  "verify you are a human",
  "human verification",
  "client challenge",
  "checking your browser",
  "enable javascript and cookies",
  "are you a robot",
  "px-captcha",
  "access to this page has been denied",
];

// DOM selectors for the embedded challenge widgets themselves - the highest-precision captcha signal (no
// false positives from page copy that merely mentions "captcha"). The caller probes these with Playwright.
export const CHALLENGE_FRAME_SELECTORS: string[] = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',
  "#px-captcha",
  "#challenge-stage",
  "#cf-challenge-running",
  ".cf-turnstile",
  ".h-captcha",
  ".g-recaptcha",
];

// A landed URL that looks like a dedicated sign-in / auth endpoint. Bounded to recognizable auth path/route
// tokens so a generic "/account" or a "login" substring inside a slug doesn't trip it.
export const LOGIN_URL_RE =
  /(?:^|[/.?#&=])(?:log[-_]?in|sign[-_]?in|signin|sign[-_]?up|signup|authenticate|authorize|oauth2?|sso|account[s]?\/(?:login|signin|sign-in))(?:[/.?#&=]|$)/i;

// Phrases a page shows when it is actively gating on auth (vs. just having a login link in the header).
export const LOGIN_TEXT_MARKERS: string[] = [
  "sign in to continue",
  "please sign in",
  "please log in",
  "log in to continue",
  "you must be logged in",
  "you need to sign in",
  "session expired",
  "your session has expired",
  "login required",
];

// Same navigation target ignoring hash + trailing slash. Self-contained so it can be lifted into the server
// alongside classifyGate (see emitGateRuntime). Falls back to string equality for non-absolute inputs.
// NOTE: no NESTED arrow functions here - the stringified body is emitted into a strict (noImplicitAny)
// server, where an inner arrow's params would have no contextual type. Keep it loop/inline only.
export const sameTarget = (a: string, b: string): boolean => {
  try {
    const l = new URL(String(a));
    const r = new URL(String(b));
    const ln = (l.origin + l.pathname.replace(/\/+$/, "")).toLowerCase() + l.search;
    const rn = (r.origin + r.pathname.replace(/\/+$/, "")).toLowerCase() + r.search;
    return ln === rn;
  } catch {
    return String(a || "") === String(b || "");
  }
};

// THE decision. Pure: given what the page looks like, is the automated session blocked, and why? Designed to
// be lifted verbatim into the standalone server, so it references only the exported tables above + globals.
//   - captcha wins over auth (a challenge page can also carry a password field; it's still a challenge).
//   - auth fires ONLY when the action failed to reach its target: either we were redirected to a sign-in
//     page, or we're sitting on a sign-in URL that is actively asking for a password. A password field on
//     its own is NOT a gate (lots of normal pages have a login widget) - the URL/redirect signal is required.
export const classifyGate = (s: GateSignals): GateResult => {
  const landed = String(s.landedUrl || "");
  const hay = (String(s.text || "") + " " + String(s.title || "")).toLowerCase();
  if (s.hasChallengeFrame === true) return { kind: "captcha", reason: "anti-bot challenge widget detected" };
  for (const m of BOT_MARKERS) {
    if (hay.indexOf(m) !== -1) return { kind: "captcha", reason: "anti-bot challenge page (" + m + ")" };
  }
  let landedLooksLikeLogin = LOGIN_URL_RE.test(landed);
  if (!landedLooksLikeLogin) {
    for (const m of LOGIN_TEXT_MARKERS) {
      if (hay.indexOf(m) !== -1) { landedLooksLikeLogin = true; break; }
    }
  }
  const redirectedAway = !!s.requestedUrl && !sameTarget(String(s.requestedUrl), landed);
  if (landedLooksLikeLogin && (redirectedAway || s.hasPasswordField === true)) {
    return { kind: "auth", reason: redirectedAway ? "redirected to a sign-in page" : "this page requires sign-in" };
  }
  return { kind: "ok", reason: "" };
};

/**
 * Serialize the gate runtime as source text for the generated server. Emits the marker tables (as JSON
 * literals) and the two pure functions (via Function.toString) under their exported names, so the standalone
 * server runs the exact logic unit-tested here. The generator builds with plain `tsc` (no minifier), so the
 * stringified function bodies are stable, readable, and reference only the constants emitted above them.
 */
export function emitGateRuntime(): string {
  // The const type annotations give the stringified arrows' top-level params a contextual `any` type, so the
  // emitted code is clean under the generated server's strict (noImplicitAny) tsconfig. The function bodies
  // (sole source of truth) carry no nested arrows, so they need no further annotation.
  return [
    "// --- gate detection (auto-emitted from services/generator/src/browser-gate.ts; single source of truth) ---",
    `const BOT_MARKERS = ${JSON.stringify(BOT_MARKERS)};`,
    `const CHALLENGE_FRAME_SELECTORS = ${JSON.stringify(CHALLENGE_FRAME_SELECTORS)};`,
    `const LOGIN_TEXT_MARKERS = ${JSON.stringify(LOGIN_TEXT_MARKERS)};`,
    `const LOGIN_URL_RE = ${LOGIN_URL_RE.toString()};`,
    `const sameTarget: (a: any, b: any) => boolean = ${sameTarget.toString()};`,
    `const classifyGate: (s: any) => { kind: string; reason: string } = ${classifyGate.toString()};`,
  ].join("\n");
}
