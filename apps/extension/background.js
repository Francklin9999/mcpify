// MCP Forge - service worker.
//  (1) Opens the side-panel chat when the toolbar icon is clicked.
//  (2) Net-intercept: silently records XHR/fetch per tab via chrome.webRequest (Module 3 of
//      docs/apps/extension.md). Secret-list headers are dropped here AND again in lib/capture.js before
//      anything leaves the client. Never reads or transmits cookies/credentials.
//
// The canonical secret list lives in packages/types/src/secret-list.json (and @mcp/types legal.ts), guarded
// by a parity test. This inline copy is the static-extension mirror - keep in sync if the list changes.
const SECRET_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "proxy-authorization"];
const SECRET_FIELD = [/token/i, /secret/i, /password/i, /session/i];
const isSecret = (name) => {
  const n = name.toLowerCase();
  return SECRET_HEADERS.includes(n) || SECRET_FIELD.some((re) => re.test(n));
};

const byTab = new Map();
const pendingHeaders = new Map();
const pendingBodies = new Map();

function inferSchema(value, depth = 0) {
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  if (typeof value === "object") {
    if (depth >= 1) return { type: "object" };
    const properties = {};
    for (const [key, nested] of Object.entries(value || {})) {
      if (!isSecret(key)) properties[key] = inferSchema(nested, depth + 1);
    }
    return { type: "object", properties };
  }
  return {};
}

function schemaFromRequestBody(requestBody) {
  if (!requestBody) return undefined;
  if (requestBody.formData) return inferSchema(Object.fromEntries(Object.entries(requestBody.formData).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])));
  const bytes = requestBody.raw?.find((part) => part?.bytes)?.bytes;
  if (!bytes) return undefined;
  try {
    const text = new TextDecoder().decode(bytes);
    if (!text) return undefined;
    try {
      return inferSchema(JSON.parse(text));
    } catch {
      if (/=/.test(text)) {
        const params = new URLSearchParams(text);
        return inferSchema(Object.fromEntries(Array.from(params.keys()).map((key) => [key, params.get(key)])));
      }
      return { type: "string" };
    }
  } catch {
    return undefined;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.type !== "xmlhttprequest") return;
    const headers = {};
    for (const h of d.requestHeaders || []) {
      if (isSecret(h.name)) continue; // never even buffer a secret
      if (h.value) headers[h.name.toLowerCase()] = h.value;
    }
    pendingHeaders.set(d.requestId, headers);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type !== "xmlhttprequest") return;
    const schema = schemaFromRequestBody(d.requestBody);
    if (schema) pendingBodies.set(d.requestId, schema);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0 || d.type !== "xmlhttprequest") return;
    const calls = byTab.get(d.tabId) || [];
    const contentType = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    calls.push({
      method: d.method,
      url: d.url,
      requestHeaders: pendingHeaders.get(d.requestId) || {},
      requestBodySchema: pendingBodies.get(d.requestId),
      status: d.statusCode,
      contentType,
    });
    pendingHeaders.delete(d.requestId);
    pendingBodies.delete(d.requestId);
    byTab.set(d.tabId, calls.slice(-200));
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => byTab.delete(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "get-capture" && typeof msg.tabId === "number") {
    sendResponse({ calls: byTab.get(msg.tabId) || [] });
  }
  return true;
});
