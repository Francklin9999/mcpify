// Web API client (01 §7). The extension talks ONLY to the web app — never to scraper/generator/monitor.
// Override the base via the options page / storage; defaults to local dev.
import { DEFAULT_API_BASE } from "./config.js";

const LEGACY_DEFAULT_API_BASES = new Set(["http://localhost:3000"]);

function normalizeApiBase(value) {
  const base = String(value || "").replace(/\/$/, "");
  return !base || LEGACY_DEFAULT_API_BASES.has(base) ? DEFAULT_API_BASE : base;
}

export async function apiBase() {
  try {
    const { apiBase } = await chrome.storage.sync.get("apiBase");
    return normalizeApiBase(apiBase);
  } catch {
    return DEFAULT_API_BASE;
  }
}

export async function generate(url, legalMode = "safe", bundle) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, legalMode, bundle }),
  });
  if (!res.ok) throw new Error(`generate failed (${res.status})`);
  return res.json(); // { jobId }
}

export async function jobStatus(jobId) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(`job status failed (${res.status})`);
  return res.json(); // { status, result?, error? }
}

export async function assist(messages, pageContext, availableTools) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/assist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, pageContext, availableTools }),
  });
  if (!res.ok) throw new Error(`assist failed (${res.status})`);
  return res.text(); // streamed/plain assistant turn
}

/**
 * Stream the assistant turn token-by-token (Claude-style live typing). `onChunk(text)` is called with each
 * decoded chunk; resolves with the full text. Pass an AbortSignal to support a Stop button.
 */
export async function assistStream(messages, pageContext, onChunk, signal, availableTools) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/assist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, pageContext, availableTools }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`assist failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    onChunk(chunk, full);
  }
  return full;
}

/**
 * One step of the side-panel AGENT loop: POST /api/assist WITH actionable `tools`, which switches the route
 * to function-calling mode and returns a JSON AssistStepResponse ({ text?, toolCalls? }) instead of a stream.
 * The caller (lib/agent.js runAgent) executes any toolCalls against the live tab and calls back for the next
 * step. Throws on transport error so the loop surfaces it.
 */
export async function assistAgentStep(messages, pageContext, tools, signal) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/assist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, pageContext, tools }),
    signal,
  });
  if (!res.ok) throw new Error(`assist failed (${res.status})`);
  return res.json(); // AssistStepResponse
}

/**
 * Find the registry serverId for a page URL so continuous discovery grows the RIGHT server. Servers are
 * one-per-URL (`generate` allocates serverId per url), so this matches the EXACT url only — a same-host but
 * different page (e.g. /products vs /blog) is a DIFFERENT server, and a fuzzy match would contaminate it with
 * the wrong page's tools. No exact match ⇒ undefined (this page has no server yet; nothing to grow).
 */
export async function findServerForUrl(url) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/registry?q=${encodeURIComponent(url)}`).catch(() => null);
  if (!res || !res.ok) return undefined;
  const entries = await res.json().catch(() => null);
  if (!Array.isArray(entries)) return undefined;
  return entries.find((e) => e.url === url)?.serverId;
}

/**
 * SYNCHRONOUS incremental discovery: given the tools already known for this page + a fresh capture, returns
 * { added, tools } (genuinely-new + merged) for live in-session use, and — when serverId is set — also grows
 * the persisted registry server. The server runs the delta-only engine (only new material reaches the model;
 * no new material ⇒ no model call). This is the "continuous generation" trigger.
 */
export async function discoverTools(currentTools, bundle, serverId) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentTools, bundle, serverId }),
  });
  if (!res.ok) throw new Error(`discover failed (${res.status})`);
  return res.json(); // { added, tools }
}

/** Poll a generate job to completion. Returns the GeneratedServerArtifact, or throws. */
export async function waitForArtifact(jobId, { onTick, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await jobStatus(jobId);
    if (onTick) onTick(s.status);
    if (s.status === "done") {
      if (!s.result) throw new Error("job done but no artifact returned");
      return s.result;
    }
    if (s.status === "failed") throw new Error(s.error || "generation failed");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for generation");
}
