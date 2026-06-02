import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension-config
 * Reserved for browser-extension defaults. The server catalog is server-side only
 * (Postgres), so no database credentials are ever sent to the browser.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({});
}
