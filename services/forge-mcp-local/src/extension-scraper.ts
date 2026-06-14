import { CaptureBundle, type LegalMode } from "@mcp/types";
import { assertPublicHttpUrl, type Scraper } from "@mcp/generator/lean";
import { getSharedBridge } from "./extension-bridge.js";
import { assembleBundle, extNetworkToRaw, type ExtNetItem } from "./playwright-scraper.js";

/**
 * Capture via the urlmcp Chrome extension: the page is rendered in the user's REAL, already-signed-in browser (see
 * extension-bridge.ts / extension-assets.ts), so logged-in sites work with no separate browser, no profile copy,
 * and minimal bot-flagging. If the extension isn't loaded/connected, this degrades to the supplied fallback scraper
 * (the normal static+stealth ladder) so turning the backend on never hard-breaks capture.
 *
 * Opt in with FORGE_BROWSER_BACKEND=extension; first run `urlmcp install-extension` and load it at chrome://extensions.
 */

const NAV_TIMEOUT_MS = Number(process.env["FORGE_BROWSER_TIMEOUT_MS"]) || 30_000;
const SETTLE_MS = Number(process.env["FORGE_BROWSER_SETTLE_MS"]) || 2_500;
const INTERACT = process.env["SCRAPER_INTERACT"] !== "0";
const WAIT_MS = Number(process.env["FORGE_EXT_WAIT_MS"]) || 20_000;
// Pause in the user's real browser tab for a sign-in/CAPTCHA wall, then continue (same handoff env as the other paths).
const AUTH_HANDOFF = process.env["FORGE_AUTH_HANDOFF"] !== "0";
const AUTH_HANDOFF_TIMEOUT_MS = Number(process.env["FORGE_AUTH_HANDOFF_TIMEOUT_MS"]) || 300_000;

export class ExtensionScraper implements Scraper {
  constructor(private readonly fallback?: Scraper) {}

  async capture(url: string, legalMode: LegalMode): Promise<CaptureBundle> {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    let bridge;
    try {
      bridge = await getSharedBridge();
    } catch (err) {
      return this.degrade(url, legalMode, `bridge failed to start (${err instanceof Error ? err.message : String(err)})`);
    }

    if (!(await bridge.waitForExtension(WAIT_MS))) {
      return this.degrade(
        url,
        legalMode,
        `the urlmcp browser extension isn't connected. Run "urlmcp install-extension", load it at chrome://extensions, and keep Chrome open`,
      );
    }

    try {
      const res = await bridge.capture(url, {
        settleMs: SETTLE_MS,
        navTimeoutMs: NAV_TIMEOUT_MS,
        interact: INTERACT,
        authHandoff: AUTH_HANDOFF,
        authTimeoutMs: AUTH_HANDOFF_TIMEOUT_MS,
      });
      // The extension navigated to a public URL we already validated, but re-check the landed URL (SSRF defense
      // parity with the other capture paths) before trusting the captured network targets.
      if (res.url && /^https?:\/\//i.test(res.url)) await assertPublicHttpUrl(res.url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
      return assembleBundle({
        url,
        legalMode,
        tier: 4,
        html: res.html,
        title: res.title || undefined,
        raw: extNetworkToRaw(res.network as ExtNetItem[]),
      });
    } catch (err) {
      return this.degrade(url, legalMode, err instanceof Error ? err.message : String(err));
    }
  }

  private degrade(url: string, legalMode: LegalMode, why: string): Promise<CaptureBundle> {
    if (this.fallback) {
      console.error(`[urlmcp] extension capture unavailable (${why}); falling back to the managed browser.`);
      return this.fallback.capture(url, legalMode);
    }
    throw new Error(`extension capture failed and no fallback is configured: ${why}`);
  }
}
