import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { DiscoverRequest, ToolDefinition, type DiscoverJob, type DiscoverResponse } from "@mcp/types";
import { servers, tools as toolsTable } from "@mcp/db";
// Deep imports: pull ONLY the incremental engine + inference clients (not codegen/worker), so this route
// stays lean and doesn't drag the MCP SDK / BullMQ worker into the request path.
import { discoverMore } from "@mcp/generator/dist/src/incremental.js";
import { makeLLMClients } from "@mcp/generator/dist/src/llm-factory.js";
import { db, jobQueue } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ToolDef = ReturnType<typeof ToolDefinition.parse>;

/** Load a server's CURRENT-version tools so discovery is seeded with what's already known — without this,
 *  an empty client baseline would make the model re-propose tools the server already has (wasted tokens). */
async function loadServerTools(serverId: string): Promise<ToolDef[]> {
  try {
    const [srv] = await db().select().from(servers).where(eq(servers.serverId, serverId)).limit(1);
    if (!srv || srv.currentVersion == null) return [];
    const rows = await db()
      .select()
      .from(toolsTable)
      .where(and(eq(toolsTable.serverId, serverId), eq(toolsTable.version, srv.currentVersion)));
    const defs: ToolDef[] = [];
    for (const r of rows) {
      const parsed = ToolDefinition.safeParse(r.definition);
      if (parsed.success) defs.push(parsed.data);
    }
    return defs;
  } catch {
    return []; // no DB / read failure — fall back to the client-provided baseline
  }
}

function unionByName(primary: ToolDef[], extra: ToolDef[]): ToolDef[] {
  const seen = new Set(primary.map((t) => t.name));
  return [...primary, ...extra.filter((t) => !seen.has(t.name))];
}

// POST /api/discover — SYNCHRONOUS incremental discovery (01 §7 additive). Runs the delta-only engine ONCE
// server-side (model key stays server-side), seeded with the server's existing tools so known tools aren't
// re-proposed. Returns the genuinely-new tools (for live in-session use) + the merged set, and — when a
// serverId is given — grows the persisted server by enqueuing a discover job that carries the ALREADY-FOUND
// tools (so the worker merges them model-free, never re-inferring the same material).
export async function POST(req: Request): Promise<Response> {
  const parsed = DiscoverRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { currentTools, bundle, serverId } = parsed.data;
  // Baseline = the server's known tools (authoritative) ∪ whatever the client already had.
  const baseline = serverId ? unionByName(await loadServerTools(serverId), currentTools) : currentTools;

  // Provider is controlled by LLM_PROVIDER env; falls back to heuristic when no key is set.
  const { inference: client } = makeLLMClients();

  let outcome;
  try {
    outcome = await discoverMore(baseline, bundle, client);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Persist-grow the registry server, carrying the new tools so the worker writes them WITHOUT re-inferring.
  if (serverId && outcome.added.length) {
    try {
      const job: DiscoverJob = { kind: "discover", serverId, bundle, candidates: outcome.added };
      await jobQueue().add("discover", job, { jobId: randomUUID() });
    } catch {
      /* queue unavailable — still return the in-session tools */
    }
  }

  const body: DiscoverResponse = { added: outcome.added, tools: outcome.tools };
  return NextResponse.json(body);
}
