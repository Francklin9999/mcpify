/**
 * Consent-overlay (cookie/GDPR) dismissal for generated servers. A curated, high-precision script emitted as
 * one JS string both browser backends run identically (Playwright page.evaluate / opencli eval): curated CMP
 * selectors first, then accept-text scoped to a consent container only - never a page-wide "click OK".
 */

// High-precision consent-accept selectors from the major CMPs (exact ids/attributes).
export const CONSENT_ACCEPT_SELECTORS: string[] = [
  "#onetrust-accept-btn-handler", // OneTrust
  ".onetrust-close-btn-handler",
  "#truste-consent-button", // TrustArc
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
  "#CybotCookiebotDialogBodyButtonAccept",
  ".fc-cta-consent", // Google Funding Choices
  ".fc-button.fc-cta-consent",
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept all cookies"]',
  'button[aria-label="Accept cookies"]',
  'button[data-testid="cookie-policy-manage-dialog-accept-button"]', // Facebook/Meta-style
  'button[data-a-target="consent-banner-accept"]', // Twitch
  'button[data-testid="accept-button"]',
  "#gdpr-consent-tool-wrapper button[mode='primary']",
  "#didomi-notice-agree-button", // Didomi
  ".qc-cmp2-summary-buttons button[mode='primary']", // Quantcast
  ".cookie-consent-accept",
  ".cc-allow", // cookieconsent (osano)
];

// Containers that plausibly hold a consent prompt - scopes the text fallback.
export const CONSENT_CONTAINER_SELECTOR =
  '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[aria-describedby*="cookie" i],[class*="gdpr" i],[id*="gdpr" i]';

// Exact accept-button labels (whole-string match, lowercased+trimmed) allowed INSIDE a consent container only.
export const CONSENT_ACCEPT_TEXT: string[] = [
  "accept all", "accept all cookies", "accept cookies", "accept", "i accept", "agree", "i agree",
  "allow all", "allow cookies", "got it", "ok", "okay", "continue", "yes, i agree", "understood",
];

/** Build the dismissal script as a self-contained IIFE string returning `{dismissed:[...]}`. Never throws. */
export function buildDismissScript(): string {
  return (
    "(function(){try{" +
    "var out=[];" +
    "var SEL=" + JSON.stringify(CONSENT_ACCEPT_SELECTORS) + ";" +
    "var TXT=" + JSON.stringify(CONSENT_ACCEPT_TEXT) + ";" +
    "var vis=function(e){return !!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));};" +
    // 1. curated vendor selectors — unambiguous, click every visible match
    "for(var i=0;i<SEL.length;i++){try{var el=document.querySelector(SEL[i]);if(el&&vis(el)){el.click();out.push(SEL[i]);}}catch(e){}}" +
    // 2. text fallback, SCOPED to consent containers only (never page-wide)
    "if(out.length===0){try{var cs=document.querySelectorAll(" + JSON.stringify(CONSENT_CONTAINER_SELECTOR) + ");" +
    "for(var c=0;c<cs.length&&out.length===0;c++){var bs=cs[c].querySelectorAll('button,[role=button],a');" +
    "for(var b=0;b<bs.length;b++){var t=(bs[b].textContent||'').trim().toLowerCase();" +
    "if(t&&TXT.indexOf(t)!==-1&&vis(bs[b])){bs[b].click();out.push('text:'+t);break;}}}}catch(e){}}" +
    "return JSON.stringify({dismissed:out});" +
    "}catch(e){return JSON.stringify({dismissed:[],error:String(e)});}})()"
  );
}

/** Emit the DISMISS_SCRIPT constant for the generated server; both backends' dismiss() run it. */
export function emitPopupRuntime(): string {
  return [
    "// --- consent/pop-up dismissal (auto-emitted from services/generator/src/popups.ts; single source of truth) ---",
    "// One curated script both browser backends evaluate. Clicks only consent controls; never throws.",
    "const DISMISS_SCRIPT = " + JSON.stringify(buildDismissScript()) + ";",
  ].join("\n");
}
