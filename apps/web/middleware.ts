import { NextResponse } from "next/server";

// API edge middleware: CORS (for the extension) + auth + rate limiting. Dev is open; production fails closed
// unless FORGE_API_KEY is set or FORGE_PUBLIC_API_OPEN=1.
//   FORGE_API_KEY        sent as `x-api-key: <key>` or `Authorization: Bearer <key>` (OPTIONS exempt)
//   FORGE_RATE_LIMIT_RPM per-IP fixed-window limit (req/min); production default 60
//   FORGE_TRUST_PROXY=1  trust X-Real-IP / X-Forwarded-For from a reverse proxy you control
//   FORGE_PUBLIC_API_OPEN=1 allow a production deployment without FORGE_API_KEY
// Rate-limit state is in-memory per Edge instance (approximate with multiple replicas; front with a real
// gateway for a hard global limit).
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

function corsJson(status: number, body: unknown): NextResponse {
  return withCors(NextResponse.json(body, { status }));
}

/** Length-aware string compare (avoids the most trivial early-exit timing leak on a high-entropy key). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedKey(req: Request): string {
  const x = req.headers.get("x-api-key");
  if (x) return x.trim();
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

// Best-effort in-memory fixed-window limiter (see note above). Keyed by client IP.
const WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  if (process.env.FORGE_TRUST_PROXY !== "1") return "global";
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

function rateLimited(req: Request, rpm: number): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now >= cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > MAX_RATE_LIMIT_KEYS) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      while (hits.size > MAX_RATE_LIMIT_KEYS) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
    }
    return false;
  }
  cur.count += 1;
  return cur.count > rpm;
}

function productionRequiresKey(): boolean {
  return process.env.NODE_ENV === "production" && process.env.FORGE_PUBLIC_API_OPEN !== "1";
}

export function middleware(req: Request): NextResponse {
  if (req.method === "OPTIONS") return withCors(new NextResponse(null, { status: 204 }));

  const apiKey = process.env.FORGE_API_KEY?.trim();
  if (!apiKey && productionRequiresKey()) {
    return corsJson(503, { error: "FORGE_API_KEY is required for production API access" });
  }
  if (apiKey && !safeEqual(presentedKey(req), apiKey)) {
    return corsJson(401, { error: "unauthorized: missing or invalid API key" });
  }

  const rpm = Number(process.env.FORGE_RATE_LIMIT_RPM) || (process.env.NODE_ENV === "production" ? 60 : 0);
  if (rpm > 0 && rateLimited(req, rpm)) {
    return corsJson(429, { error: "rate limit exceeded, slow down" });
  }

  return withCors(NextResponse.next());
}
