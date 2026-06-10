/**
 * Gate detection (CAPTCHA / sign-in wall) for the generated server's browser session. The pure classifyGate
 * + its marker tables are unit-tested here, and emitGateRuntime() serializes them verbatim into the generated
 * server.ts, so the shipped runtime can't drift from the tested logic. No imports (lifted into a standalone server).
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

// Anti-bot challenge text markers (mirrors the scraper's _BOT_MARKERS). Conservative: a false captcha pauses the agent.
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

// Embedded challenge-widget selectors: the highest-precision captcha signal. Probed with Playwright.
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

// A landed URL that looks like a dedicated sign-in/auth endpoint (bounded to auth path tokens).
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

// Same navigation target ignoring hash + trailing slash. Lifted into the server, so keep it self-contained
// with no nested arrows (their params would be untyped under the generated server's noImplicitAny).
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

// The decision: is the session blocked, and why? captcha wins over auth. auth fires only when the action
// failed to reach its target (redirected to sign-in, or sitting on a sign-in URL asking for a password) - a
// password field alone is not a gate.
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

/** Serialize the gate runtime (marker tables as JSON + the pure functions via toString) for the generated server. */
export function emitGateRuntime(): string {
  // The `: any` annotations give the stringified arrows' params a contextual type under the server's noImplicitAny.
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
