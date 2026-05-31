import { NextResponse } from "next/server";

// CORS for the Chrome extension. The side panel fetches these routes from a chrome-extension:// origin.
// `<all_urls>` host_permissions usually suffice, but adding permissive CORS + preflight handling makes the
// extension work out of the box and is harmless for the same-origin web UI. Scope: API routes only.
export const config = { matcher: "/api/:path*" };

function withCors(res: NextResponse): NextResponse {
  // Fully open: wildcard origin + headers, all methods (no credentials — the spec-safe "allow everything").
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Expose-Headers", "*");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

export function middleware(req: Request): NextResponse {
  if (req.method === "OPTIONS") return withCors(new NextResponse(null, { status: 204 }));
  return withCors(NextResponse.next());
}
