import { NextResponse } from "next/server";
import { z } from "zod";
import { GeneratedServerArtifact } from "@mcp/types";
import { artifactFromFileUrl } from "@/lib/artifacts";
import { findCatalogArtifact } from "@/lib/catalog-store";
import { getServerVersion } from "@/lib/registry";
import { buildZip } from "@/lib/zip";

export const dynamic = "force-dynamic";

const Params = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

async function artifactFromCatalog(serverId: string, version: number) {
  const doc = await findCatalogArtifact(serverId).catch(() => null);
  if (!doc) return null;
  const parsed = GeneratedServerArtifact.safeParse(doc.artifact);
  if (!parsed.success || parsed.data.version !== version) return null;
  return parsed.data;
}

function slug(value: string) {
  return String(value || "mcp-server").replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "mcp-server";
}

function zipResponse(artifact: GeneratedServerArtifact, nameHint: string) {
  const root = `${slug(nameHint)}-v${artifact.version}`;
  const entries = [
    ...artifact.files,
    { path: "artifact.json", content: JSON.stringify(artifact, null, 2) },
  ];
  const bytes = buildZip(entries, root);
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${root}.zip"`,
      "cache-control": "no-store",
    },
  });
}

// GET /api/servers/:id/download/:version - return an artifact JSON by default, or a zip with ?format=zip.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  const parsed = Params.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid download params" }, { status: 400 });
  const wantsZip = new URL(req.url).searchParams.get("format") === "zip";

  const version = await getServerVersion(parsed.data.id, parsed.data.version);
  if (!version) {
    const catalogArtifact = await artifactFromCatalog(parsed.data.id, parsed.data.version);
    if (catalogArtifact) return wantsZip ? zipResponse(catalogArtifact, catalogArtifact.serverId) : NextResponse.json(catalogArtifact);
    return NextResponse.json({ error: "version not found" }, { status: 404 });
  }

  const localArtifact = await artifactFromFileUrl(version.artifactUrl, version.serverId, version.version);
  if (localArtifact) return wantsZip ? zipResponse(localArtifact, version.serverId) : NextResponse.json(localArtifact);

  return NextResponse.redirect(version.artifactUrl);
}
