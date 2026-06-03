import { NextResponse } from "next/server";
import { catalogConfigured, listCatalog, findCatalogByDomain, upsertCatalog } from "@/lib/catalog-store";
import { readJsonWithLimit } from "@/lib/request-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function decorateCatalogDoc<T extends Record<string, any>>(doc: T): T {
  const version = Number(doc.version ?? doc.artifact?.version ?? 1);
  const domain = typeof doc.domain === "string" ? doc.domain : "";
  const downloadUrl = `/api/atlas/download?domain=${encodeURIComponent(domain)}`;
  return {
    ...doc,
    currentVersion: version,
    toolCount: Array.isArray(doc.tools) ? doc.tools.length : doc.toolCount,
    qualityTier: Array.isArray(doc.tags) && doc.tags.includes("really_good") ? "really_good" : "standard",
    downloadUrl: doc.downloadUrl ?? downloadUrl,
    installUrl: doc.installUrl ?? downloadUrl,
  };
}

/**
 * GET /api/atlas?domain=example.com
 * Returns the stored catalog record for this domain, or a catalog list when domain is omitted.
 * Backed by the Postgres `catalog` table (formerly MongoDB Atlas).
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain")?.trim();
  const q = searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 100), 1), 200);

  if (!catalogConfigured()) return NextResponse.json({ error: "catalog not configured" }, { status: 503 });

  try {
    if (!domain) {
      const items = await listCatalog({ q, limit, all: searchParams.get("all") === "1" });
      return NextResponse.json({ items: items.map(decorateCatalogDoc), count: items.length });
    }
    const doc = await findCatalogByDomain(domain);
    if (!doc) return NextResponse.json(null, { status: 404 });
    return NextResponse.json(decorateCatalogDoc(doc));
  } catch {
    return NextResponse.json({ error: "catalog unavailable" }, { status: 503 });
  }
}

/**
 * POST /api/atlas
 * Upserts a catalog record for a domain (MERGE: only provided fields are written).
 * Body: { domain, origin?, serverId?, tools?, version?, title? }
 */
export async function POST(req: Request): Promise<Response> {
  const parsed = await readJsonWithLimit(req, 256_000);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const body = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown>
    : null;
  const domain = typeof body?.domain === "string" ? body.domain.trim() : "";
  if (!body || !domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  if (!catalogConfigured()) return NextResponse.json({ error: "catalog not configured" }, { status: 503 });

  try {
    await upsertCatalog(domain, body);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "catalog unavailable" }, { status: 503 });
  }
}
