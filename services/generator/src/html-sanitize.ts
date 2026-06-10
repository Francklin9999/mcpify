/**
 * Lexical pre-processing for HTML structure mining: strip markup a browser never renders as live DOM
 * (comments, <script>/<style>/<template>/<svg>/<math>) so the link/form miners don't extract phantom tools,
 * and resolve <base href> for correct relative-URL resolution. <noscript> is kept (genuine fallback markup).
 * Pure, dependency-free, never throws.
 */

const COMMENT_RE = /<!--[\s\S]*?-->/g;
// Raw-text / inert / foreign-content elements whose contents aren't live DOM links or forms.
const NON_RENDERED_RE = /<(script|style|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Strip comments (first, so a commented-out tag can't dangle), then non-rendered blocks; each becomes a
 * space. An unterminated block is left intact rather than swallowing the rest of the document.
 */
export function stripNonRenderedMarkup(html: string): string {
  if (!html) return "";
  return html.replace(COMMENT_RE, " ").replace(NON_RENDERED_RE, " ");
}

function attrValue(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * Resolve the document's effective base URL: the first <base href> resolved against pageUrl (browser
 * semantics), or pageUrl when there's no usable http(s) <base>. Never throws.
 */
export function resolveBaseHref(html: string, pageUrl: string): string {
  if (!html) return pageUrl;
  // Strip comments first so a <base> inside a comment can't shadow the real one.
  const tag = html.replace(COMMENT_RE, " ").match(/<base\b[^>]*>/i)?.[0];
  if (!tag) return pageUrl;
  const href = attrValue(tag, "href");
  if (!href) return pageUrl;
  try {
    const resolved = new URL(href, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return pageUrl;
    return resolved.toString();
  } catch {
    return pageUrl;
  }
}
