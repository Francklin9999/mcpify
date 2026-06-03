import { createServer, type IncomingMessage, type Server } from "node:http";
import { Queue } from "bullmq";
import { Job, QUEUE_NAME } from "@mcp/types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-enqueue-token",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const MAX_BODY_BYTES = Number(process.env.ENQUEUE_MAX_BODY_BYTES || 512_000);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedToken(req: IncomingMessage): string {
  const direct = req.headers["x-enqueue-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1]!.trim() : "";
}

function enqueueToken(): string {
  return process.env.ENQUEUE_TOKEN?.trim() || "";
}

function tokenRequired(): boolean {
  return process.env.NODE_ENV === "production" && process.env.ENQUEUE_ALLOW_OPEN !== "1";
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error & { statusCode?: number }) => {
      if (settled) return;
      settled = true;
      req.pause();
      reject(err);
    };
    const contentLength = Number(req.headers["content-length"] || "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      fail(Object.assign(new Error(`request body too large; max ${maxBytes} bytes`), { statusCode: 413 }));
      return;
    }

    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(Object.assign(new Error(`request body too large; max ${maxBytes} bytes`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => fail(err));
  });
}

/**
 * Thin enqueue shim (the cross-language producer path). The Go monitor POSTs jobs here; this validates
 * each through the `Job` contract (fail-closed on the Go->Node seam) and calls `queue.add`. Keeps BullMQ's
 * Redis internals on the Node side so Go never has to replicate them.
 */
export async function startEnqueueServer(port: number, connection: { host: string; port: number }): Promise<{ server: Server; queue: Queue }> {
  const queue = new Queue(QUEUE_NAME, { connection });
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/enqueue") {
      res.writeHead(404, CORS_HEADERS);
      res.end();
      return;
    }
    const token = enqueueToken();
    if (!token && tokenRequired()) {
      res.writeHead(503, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: "ENQUEUE_TOKEN is required in production" }));
      return;
    }
    if (token && !safeEqual(presentedToken(req), token)) {
      res.writeHead(401, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    try {
      const body = await readBody(req, MAX_BODY_BYTES);
      const parsed = Job.parse(JSON.parse(body)); // reject a malformed job from the wire
      await queue.add(parsed.kind, parsed);
      res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, kind: parsed.kind }));
    } catch (err) {
      const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 400;
      res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, queue };
}
