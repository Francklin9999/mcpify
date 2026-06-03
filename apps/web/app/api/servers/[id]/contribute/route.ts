import { NextResponse } from "next/server";
import { z } from "zod";
import { ContributeRequest, type DiscoverJob } from "@mcp/types";
import { storeContribution } from "@/lib/contributions";
import { jobQueue } from "@/lib/db";
import { readJsonWithLimit } from "@/lib/request-body";

export const dynamic = "force-dynamic";

const ServerIdParam = z.string().uuid();

// POST /api/servers/:id/contribute - accept an extension/community CaptureBundle, store it, and enqueue a
// `discover` job. The worker runs INCREMENTAL discovery: a reactive page that revealed new structure grows
// the server by exactly the new tools (token-efficient - only the delta reaches the model), or no-ops when
// nothing is new. This is the trigger for "continuous" generation (the extension contributes as it browses).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const serverId = ServerIdParam.safeParse(id);
  if (!serverId.success) return NextResponse.json({ error: "invalid server id" }, { status: 400 });

  const body = await readJsonWithLimit(req, 512_000);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = ContributeRequest.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { bundleRef } = await storeContribution(serverId.data, parsed.data.bundle);

  // Enqueue incremental discovery (best-effort: storing the contribution is the durable part; if the queue
  // is unavailable we still accept the contribution rather than fail the request).
  let jobId: string | undefined;
  try {
    jobId = crypto.randomUUID();
    const job: DiscoverJob = { kind: "discover", serverId: serverId.data, bundle: parsed.data.bundle };
    await jobQueue().add("discover", job, { jobId });
  } catch {
    jobId = undefined;
  }

  return NextResponse.json({ status: "pending", bundleRef, jobId }, { status: 202 });
}
