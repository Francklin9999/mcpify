import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension-config
 * Reserved for browser-extension defaults. MongoDB Atlas is server-side only
 * (MONGODB_URI), so no credentials are sent to the browser.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({});
}
