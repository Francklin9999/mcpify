import { NextResponse } from "next/server";
import { toolsCollection } from "@/lib/mongo";

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
 * Returns the stored tool record for this domain, or a catalog list when domain is omitted.
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain")?.trim();
  const q = searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 100), 1), 200);

  const col = await toolsCollection();
  if (!col) return NextResponse.json({ error: "MongoDB not configured" }, { status: 503 });

  if (!domain) {
    const workingOnly =
      searchParams.get("all") !== "1"
        ? {
            status: "active",
            "artifact.files.0": { $exists: true },
            "artifact.tools.1": { $exists: true },
            "localTest.passed": true,
            toolCount: { $gte: 2 },
          }
        : {};
    const filter = q
      ? {
          ...workingOnly,
          $or: [
            { domain: { $regex: q, $options: "i" } },
            { title: { $regex: q, $options: "i" } },
            { origin: { $regex: q, $options: "i" } },
            { "tools.name": { $regex: q, $options: "i" } },
            { "tools.description": { $regex: q, $options: "i" } },
          ],
        }
      : workingOnly;
    const items = await col
      .find(filter, { projection: { _id: 0 } })
      .sort({ confidence: -1, toolCount: -1, title: 1 })
      .limit(limit)
      .toArray();
    return NextResponse.json({ items: items.map(decorateCatalogDoc), count: items.length });
  }

  const doc = await col.findOne({ domain }, { projection: { _id: 0 } });
  if (!doc) return NextResponse.json(null, { status: 404 });
  return NextResponse.json(decorateCatalogDoc(doc));
}

/**
 * POST /api/atlas
 * Upserts a tool record for a domain.
 * Body: { domain, origin?, serverId?, tools?, version?, title? }
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const domain = body?.domain?.trim();
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  const col = await toolsCollection();
  if (!col) return NextResponse.json({ error: "MongoDB not configured" }, { status: 503 });

  await col.updateOne(
    { domain },
    { $set: { domain, ...body, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
  return NextResponse.json({ ok: true });
}
