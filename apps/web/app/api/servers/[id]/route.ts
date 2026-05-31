import { NextResponse } from "next/server";
import { getServerDetail } from "@/lib/registry";

export const dynamic = "force-dynamic";

// GET /api/servers/:id -> RegistryEntry & { versions: ServerVersion[] } (01 S7)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const server = await getServerDetail(id);
  if (!server) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(server);
}
