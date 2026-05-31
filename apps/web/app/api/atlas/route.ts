import { NextResponse } from "next/server";
import { toolsCollection } from "@/lib/mongo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/atlas?domain=example.com
 * Returns the stored tool record for this domain, or 404 if not found.
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain")?.trim();
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  const col = await toolsCollection();
  if (!col) return NextResponse.json({ error: "MongoDB not configured" }, { status: 503 });

  const doc = await col.findOne({ domain }, { projection: { _id: 0 } });
  if (!doc) return NextResponse.json(null, { status: 404 });
  return NextResponse.json(doc);
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
