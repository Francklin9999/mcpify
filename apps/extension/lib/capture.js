// Runtime mirror of lib/capture.ts for the static MV3 extension. It builds the same CaptureBundle shape
// without importing @mcp/types into Chrome.
const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "proxy-authorization"]);
const SECRET_FIELD = [/token/i, /secret/i, /password/i, /session/i, /auth/i, /cookie/i];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const MAX_HTML = 120000;

function isSecretName(name) {
  const n = String(name || "").toLowerCase();
  return SECRET_HEADERS.has(n) || SECRET_FIELD.some((re) => re.test(n)) || n === "key" || n.endsWith("_key") || n.endsWith("-key");
}

function scrubHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isSecretName(key) && value != null) out[key] = String(value);
  }
  return out;
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSecretName(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function templateUrl(rawUrl) {
  const safe = sanitizeUrl(rawUrl);
  if (!safe) return "/";
  const url = new URL(safe);
  return url.pathname
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || UUID.test(segment) || HEX.test(segment) ? "{id}" : segment))
    .join("/");
}

export function inferSchema(value, depth = 0) {
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  if (typeof value === "object") {
    if (depth >= 1) return { type: "object" };
    const properties = {};
    for (const [key, nested] of Object.entries(value || {})) {
      if (!isSecretName(key)) properties[key] = inferSchema(nested, depth + 1);
    }
    return { type: "object", properties };
  }
  return {};
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function buildCaptureBundle(input) {
  const url = sanitizeUrl(input.url);
  if (!url) throw new Error("Cannot build capture bundle without a valid page URL.");

  const html = String(input.html || "").slice(0, MAX_HTML);
  const network = (input.calls || [])
    .map((call) => {
      const rawUrl = sanitizeUrl(call.url);
      if (!rawUrl) return null;
      return {
        method: String(call.method || "GET").toUpperCase(),
        urlPattern: templateUrl(rawUrl),
        rawUrl,
        requestHeaders: scrubHeaders(call.requestHeaders || {}),
        requestBodySchema: call.requestBodySchema,
        responseSchema: call.responseBody !== undefined ? inferSchema(call.responseBody) : undefined,
        statusCode: Number(call.status || 0),
        contentType: String(call.contentType || ""),
      };
    })
    .filter(Boolean);

  return {
    bundleId: crypto.randomUUID(),
    source: "extension",
    url,
    capturedAt: new Date().toISOString(),
    legalMode: input.legalMode || "session",
    dom: {
      html,
      domHash: await sha256(html),
      selectorsOfInterest: input.selectorsOfInterest?.length ? input.selectorsOfInterest.slice(0, 120) : undefined,
    },
    network,
    page: input.page,
    meta: {
      title: input.title || undefined,
      renderedWithJs: true,
    },
  };
}
