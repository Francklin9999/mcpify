/**
 * Lexical pre-processing for HTML STRUCTURE mining (links / forms / buttons).
 *
 * The structure miners in `html-analysis.ts` run regexes over the page to find `<a>`, `<form>`, and
 * `<button>` elements. Run over RAW html those regexes also match markup that a browser would NEVER turn
 * into a live link or form - markup that exists only as:
 *   - the text of an HTML comment        (`<!-- <a href="/old">…</a> -->`)
 *   - a string literal inside `<script>` (`var t = '<form action="/x">…';`)
 *   - CSS content inside `<style>`        (`.x::after { content: "<a …>"; }`)
 *   - an inert `<template>` fragment      (not in the live tree until JS clones it)
 *   - SVG/MathML foreign content          (`<a xlink:href>` is not an HTML hyperlink)
 * Mining those yields phantom tools (e.g. a `<form>` commented out of the page becoming a real tool). This
 * module returns a copy of the html with exactly those regions removed, so the miners see only live DOM.
 *
 * `<noscript>` is deliberately KEPT: its fallback `<form>`/`<a>` are genuine server-side markup a no-JS
 * client follows, and are often the cleanest (non-JS) version of a site's search box.
 *
 * It also resolves the document's `<base href>` (browsers resolve every relative URL against it, not the
 * page URL), so a page at `/listing/page-2` with `<base href="/shop/">` templates `products/42` as
 * `/shop/products/42` instead of the wrong `/listing/products/42`.
 *
 * Pure, dependency-free, and never throws - a parse failure must never block generation.
 */

const COMMENT_RE = /<!--[\s\S]*?-->/g;
// Raw-text / inert / foreign-content elements whose contents are not live DOM links or forms:
// script, style (raw-text/code), template (inert fragment), svg, math (foreign content). One alternation
// pass with a backreferenced close tag (`\1`, case-insensitive under /i) instead of one pass per tag.
const NON_RENDERED_RE = /<(script|style|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Remove markup a browser would not render as live links/forms: HTML comments, then `<script>`/`<style>`/
 * `<template>`/`<svg>`/`<math>` blocks. Each region becomes a single space so surrounding tag boundaries
 * and token separation are preserved. Comments are stripped FIRST so a commented-out `<script>` can't leave
 * a dangling open tag behind. An UNTERMINATED block (no closing tag) is left intact rather than swallowing
 * the rest of the document - over-keeping is safer than dropping a whole page over one missing tag.
 *
 * Side benefit: on script/SVG-heavy pages this shrinks the input the downstream miners scan, so structure
 * extraction is also faster.
 */
export function stripNonRenderedMarkup(html: string): string {
  if (!html) return "";
  // Comments first so a commented-out <script> can't leave a dangling open tag, then one combined pass.
  return html.replace(COMMENT_RE, " ").replace(NON_RENDERED_RE, " ");
}

function attrValue(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * Resolve the document's effective base URL for relative-link resolution: the first `<base href>` resolved
 * against `pageUrl` (browser semantics), or `pageUrl` itself when there is no usable `<base>`. Only http(s)
 * bases are honored; anything else (or any parse failure) falls back to `pageUrl`. Never throws.
 */
export function resolveBaseHref(html: string, pageUrl: string): string {
  if (!html) return pageUrl;
  // Strip comments first so a `<base>` written inside an HTML comment can't shadow the real one.
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
