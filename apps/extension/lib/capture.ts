import { CaptureBundle, scrubHeaders, type CaptureBundle as CaptureBundleT, type NetworkCapture, type PageSnapshot } from "@mcp/types";

/**
 * Net-intercept → CaptureBundle (docs/apps/extension.md Module 3). Produces a bundle SHAPE-IDENTICAL to
 * the scraper's `source:'scraper'` output (01 §1) — the generator must not be able to tell them apart.
 * The build validates against the SAME @mcp/types contract the generator uses (fail-closed), and applies
 * the SAME shared `scrubHeaders` (04) so no credential/secret ever leaves the client.
 */
export interface RecordedCall {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  contentType: string;
  requestBodySchema?: Record<string, unknown>;
  responseBody?: unknown; // a SCHEMA is inferred from this; the raw value is never persisted
}

export interface CaptureInput {
  url: string;
  html: string;
  title?: string;
  calls: RecordedCall[];
  page?: PageSnapshot;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;

/** Mirror of the scraper's template_url: id-like path segments -> {id}. */
export function templateUrl(raw: string): string {
  const m = raw.match(/^[a-z]+:\/\/[^/]+/i);
  const origin = m ? m[0] : "";
  const path = raw.slice(origin.length).split("?")[0] ?? "";
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || UUID.test(seg) || HEX.test(seg) ? "{id}" : seg))
    .join("/");
}

/** Shallow JSON-Schema-ish inference (1 nested level). Schemas only — never raw values (04). */
export function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  if (typeof value === "object") {
    if (depth >= 1) return { type: "object" };
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = inferSchema(v, depth + 1);
    return { type: "object", properties };
  }
  return {};
}

export async function buildCaptureBundle(input: CaptureInput): Promise<CaptureBundleT> {
  const network: NetworkCapture[] = input.calls.map((c) => ({
    method: c.method,
    urlPattern: templateUrl(c.url),
    rawUrl: c.url,
    requestHeaders: scrubHeaders(c.requestHeaders), // SHARED scrub — strips secrets before anything leaves the client
    requestBodySchema: c.requestBodySchema,
    responseSchema: c.responseBody !== undefined ? inferSchema(c.responseBody) : undefined,
    statusCode: c.status,
    contentType: c.contentType,
  }));

  // CaptureBundle.parse is the fail-closed gate: same contract the generator + scraper-mirror enforce.
  return CaptureBundle.parse({
    bundleId: crypto.randomUUID(),
    source: "extension",
    url: input.url,
    capturedAt: new Date().toISOString(),
    legalMode: "session",
    dom: { html: input.html, domHash: await sha256(input.html) },
    network,
    page: input.page,
    meta: { title: input.title, renderedWithJs: true },
  });
}
