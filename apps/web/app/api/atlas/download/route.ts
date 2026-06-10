import { NextResponse } from "next/server";
import { GeneratedServerArtifact } from "@mcp/types";
import { catalogConfigured, findCatalogArtifact } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-server";
}

/**
 * GET /api/atlas/download?domain=example.com | ?serverId=uuid
 * Returns the generated MCP server artifact from the Postgres catalog (files, entrypoint, config snippet, tools).
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain")?.trim();
  const serverId = searchParams.get("serverId")?.trim();
  const requestedVersion = Number(searchParams.get("version") ?? "1");

  if (!domain && !serverId) {
    return NextResponse.json({ error: "domain or serverId required" }, { status: 400 });
  }

  if (!catalogConfigured()) return NextResponse.json({ error: "catalog not configured" }, { status: 503 });

  const doc = await findCatalogArtifact(String(domain || serverId)).catch(() => null);
  if (!doc) return NextResponse.json({ error: "artifact not found" }, { status: 404 });

  const artifact = GeneratedServerArtifact.safeParse(doc.artifact);
  if (!artifact.success) return NextResponse.json({ error: "stored artifact is invalid" }, { status: 500 });
  if (artifact.data.version !== requestedVersion) {
    return NextResponse.json({ error: "version not found" }, { status: 404 });
  }

  return new Response(JSON.stringify(artifact.data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName(String(doc.domain ?? doc.serverId))}-v${artifact.data.version}.artifact.json"`,
      "x-mcp-server-id": artifact.data.serverId,
      "x-mcp-tool-count": String(artifact.data.tools?.length ?? 0),
    },
  });
}
