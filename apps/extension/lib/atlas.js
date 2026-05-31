/**
 * MongoDB Atlas integration — routes through the web app's /api/atlas so the
 * MongoDB credentials stay server-side and never touch the browser.
 *
 * The web app must have MONGODB_URI set in .env. If it isn't, the routes
 * return 503 and every call here silently no-ops.
 */
import { apiBase } from "./api.js";

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** Returns the stored tool record for this domain, or null if not found / not configured. */
export async function fetchToolsFromAtlas(url) {
  const domain = domainOf(url);
  if (!domain) return null;
  try {
    const base = await apiBase();
    const res = await fetch(`${base}/api/atlas?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Upserts a tool record for this domain. Fire-and-forget safe. */
export async function saveToolsToAtlas(url, record) {
  const domain = domainOf(url);
  if (!domain) return;
  try {
    const base = await apiBase();
    const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
    await fetch(`${base}/api/atlas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain, origin, ...record }),
    });
  } catch {
    // silently ignore — Atlas is optional
  }
}
