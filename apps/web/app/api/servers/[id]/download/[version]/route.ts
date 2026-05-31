import { NextResponse } from "next/server";
import { z } from "zod";
import { artifactFromFileUrl } from "@/lib/artifacts";
import { getServerVersion } from "@/lib/registry";

export const dynamic = "force-dynamic";

const Params = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

// GET /api/servers/:id/download/:version — return a local artifact JSON in dev, or redirect to object storage.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  const parsed = Params.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid download params" }, { status: 400 });

  const version = await getServerVersion(parsed.data.id, parsed.data.version);
  if (!version) return NextResponse.json({ error: "version not found" }, { status: 404 });

  const localArtifact = await artifactFromFileUrl(version.artifactUrl, version.serverId, version.version);
  if (localArtifact) return NextResponse.json(localArtifact);

  return NextResponse.redirect(version.artifactUrl);
}
