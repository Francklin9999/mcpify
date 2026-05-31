import { z } from "zod";

/**
 * LegalMode - frozen enum (`01 S6`, policy in `04-legal-modes.md`).
 * v1 scope: all three are valid for CAPTURE, but `session`-mode EXECUTION is post-v1 (see ExecutionStrategy).
 */
export const LegalMode = z.enum(["safe", "full_scrape", "session"]);
export type LegalMode = z.infer<typeof LegalMode>;

/**
 * Secret-list. INLINED (not a JSON import) so every bundler - Next, Parcel/Plasmo - can consume this
 * package; the `with { type: "json" }` import attribute breaks Parcel. The canonical, language-neutral
 * source is `src/secret-list.json` (read by the Python scraper); a parity test (contracts.test.ts) asserts
 * these stay byte-for-byte in sync, so the cross-language single-source guarantee holds via CI.
 */
const SECRET_LIST = {
  headers: ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "proxy-authorization"],
  fieldPatterns: ["*token*", "*secret*", "*password*", "*session*"],
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

/**
 * Strip secret-list headers/fields from a header map. Applied by scraper + extension BEFORE any
 * persistence or transmission (`04`). Never mutates the input.
 */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!isSecretHeader(k) && !isSecretField(k)) out[k] = v;
  }
  return out;
}
