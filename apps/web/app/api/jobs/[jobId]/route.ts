import { NextResponse } from "next/server";
import { jobQueue } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATE_MAP: Record<string, string> = { completed: "done", failed: "failed", active: "running" };

function jobResult(returnvalue: unknown): unknown {
  if (returnvalue && typeof returnvalue === "object" && "result" in returnvalue) {
    return (returnvalue as { result?: unknown }).result;
  }
  return undefined;
}

// GET /api/jobs/:jobId -> { status, result?, error? } (01 §7)
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await params;
  const job = await jobQueue().getJob(jobId);
  if (!job) return NextResponse.json({ status: "queued" });
  const state = await job.getState();
  return NextResponse.json({
    status: STATE_MAP[state] ?? "queued",
    result: jobResult(job.returnvalue),
    error: job.failedReason ?? undefined,
  });
}
