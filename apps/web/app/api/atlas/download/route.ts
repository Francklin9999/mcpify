import { NextResponse } from "next/server";
import { GeneratedServerArtifact } from "@mcp/types";
import { toolsCollection } from "@/lib/mongo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-server";
}

/**
 * GET /api/atlas/download?domain=example.com
 * GET /api/atlas/download?serverId=uuid
 *
 * Returns the generated MCP server artifact stored in MongoDB. The artifact includes runnable files,
 * the entrypoint, Claude Code config snippet, and structured tools for direct client integration.
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain")?.trim();
  const serverId = searchParams.get("serverId")?.trim();
  const requestedVersion = Number(searchParams.get("version") ?? "1");

  if (!domain && !serverId) {
    return NextResponse.json({ error: "domain or serverId required" }, { status: 400 });
  }

  const col = await toolsCollection();
  if (!col) return NextResponse.json({ error: "MongoDB not configured" }, { status: 503 });

  const doc = await col.findOne(
    {
      ...(domain ? { domain } : { serverId }),
      status: "active",
      "localTest.passed": true,
      "artifact.files.0": { $exists: true },
      "artifact.tools.1": { $exists: true },
      toolCount: { $gte: 2 },
    },
    { projection: { _id: 0, artifact: 1, domain: 1, serverId: 1, version: 1 } },
  );
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
