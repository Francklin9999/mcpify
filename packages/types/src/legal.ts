import { z } from "zod";

/** LegalMode - frozen enum. All three are valid for capture; session-mode execution is post-v1. */
export const LegalMode = z.enum(["safe", "full_scrape", "session"]);
export type LegalMode = z.infer<typeof LegalMode>;

// Inlined (not a JSON import) so every bundler can consume this package. Kept in sync with the canonical
// src/secret-list.json (read by the Python scraper) via a parity test.
const SECRET_LIST = {
  headers: ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "proxy-authorization"],
  fieldPatterns: [
    "*token*",
    "*secret*",
    "*password*",
    "*session*",
    "pwd",
    "*passcode*",
    "*otp*",
    "*cvv*",
    "*cvc*",
    "*ccv*",
    "cardNumber",
    "card_number",
    "*ssn*",
    "securityCode",
    "security_code",
  ],
} as const;

export const SECRET_HEADERS: readonly string[] = SECRET_LIST.headers.map((h) => h.toLowerCase());
export const SECRET_FIELD_PATTERNS: readonly string[] = SECRET_LIST.fieldPatterns;

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Glob (`*` = any run) -> anchored, case-insensitive RegExp. Mirror this exactly in the Python port. */
function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRegExp).join(".*") + "$", "i");
}

const fieldPatternRegexes = SECRET_FIELD_PATTERNS.map(globToRegExp);

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADERS.includes(name.toLowerCase());
}

export function isSecretField(name: string): boolean {
  return fieldPatternRegexes.some((re) => re.test(name));
}

/** Strip secret-list headers/fields from a header map, before any persistence or transmission. Never mutates. */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!isSecretHeader(k) && !isSecretField(k)) out[k] = v;
  }
  return out;
}
