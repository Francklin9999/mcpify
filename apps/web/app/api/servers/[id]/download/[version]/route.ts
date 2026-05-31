import { NextResponse } from "next/server";
import { z } from "zod";
import { GeneratedServerArtifact } from "@mcp/types";
import { artifactFromFileUrl } from "@/lib/artifacts";
import { toolsCollection } from "@/lib/mongo";
import { getServerVersion } from "@/lib/registry";

export const dynamic = "force-dynamic";

const Params = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

async function artifactFromAtlas(serverId: string, version: number) {
  const col = await toolsCollection();
  if (!col) return null;
  const doc = await col.findOne(
    {
      serverId,
      version,
      status: "active",
      "localTest.passed": true,
      "artifact.files.0": { $exists: true },
      "artifact.tools.1": { $exists: true },
      toolCount: { $gte: 2 },
    },
    { projection: { _id: 0, artifact: 1 } },
  );
  const parsed = GeneratedServerArtifact.safeParse(doc?.artifact);
  return parsed.success ? parsed.data : null;
}

// GET /api/servers/:id/download/:version - return a local artifact JSON in dev, or redirect to object storage.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  const parsed = Params.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid download params" }, { status: 400 });

  const version = await getServerVersion(parsed.data.id, parsed.data.version);
  if (!version) {
    const atlasArtifact = await artifactFromAtlas(parsed.data.id, parsed.data.version);
    if (atlasArtifact) return NextResponse.json(atlasArtifact);
    return NextResponse.json({ error: "version not found" }, { status: 404 });
  }

  const localArtifact = await artifactFromFileUrl(version.artifactUrl, version.serverId, version.version);
  if (localArtifact) return NextResponse.json(localArtifact);

  return NextResponse.redirect(version.artifactUrl);
}
