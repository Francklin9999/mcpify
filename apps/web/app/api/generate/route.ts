import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { GenerateRequest, type GenerateJob } from "@mcp/types";
import { jobQueue } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/generate — validate { url, legalMode, acknowledgedFullScrape? } (full_scrape gated by the
// contract refine, 04), enqueue a GenerateJob, return { jobId }. (01 §7)
export async function POST(req: Request): Promise<Response> {
  const parsed = GenerateRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { url, legalMode, bundle } = parsed.data;
  const jobId = randomUUID();
  const job: GenerateJob = { kind: "generate", url, legalMode, requestedBy: bundle?.source === "extension" ? "extension" : "web", bundle };
  await jobQueue().add("generate", job, { jobId });
  return NextResponse.json({ jobId });
}
