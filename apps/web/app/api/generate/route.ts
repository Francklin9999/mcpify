import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { GenerateRequest, type GenerateJob } from "@mcp/types";
import { jobQueue } from "@/lib/db";
import { readJsonWithLimit } from "@/lib/request-body";

export const dynamic = "force-dynamic";

// POST /api/generate - validate { url, legalMode, acknowledgedFullScrape? } (full_scrape gated by the
// contract refine, 04), enqueue a GenerateJob, return { jobId }. (01 S7)
export async function POST(req: Request): Promise<Response> {
  const body = await readJsonWithLimit(req, 512_000);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = GenerateRequest.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { url, legalMode, bundle } = parsed.data;
  const jobId = randomUUID();
  const job: GenerateJob = { kind: "generate", url, legalMode, requestedBy: bundle?.source === "extension" ? "extension" : "web", bundle };
  await jobQueue().add("generate", job, { jobId });
  return NextResponse.json({ jobId });
}
