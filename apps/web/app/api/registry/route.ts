import { NextResponse } from "next/server";
import { listRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

// GET /api/registry?tier=&q= -> RegistryEntry[] (01 §7)
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const rows = await listRegistry({
    tier: searchParams.get("tier"),
    q: searchParams.get("q"),
  });
  return NextResponse.json(rows);
}
