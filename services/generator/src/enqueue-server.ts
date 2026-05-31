import { createServer, type Server } from "node:http";
import { Queue } from "bullmq";
import { Job, QUEUE_NAME } from "@mcp/types";

// Fully-open CORS so any web UI / extension origin can POST jobs here.
// Wildcard origin + headers (no credentials) is the spec-safe "allow everything" combo.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * Thin enqueue shim (the cross-language producer path). The Go monitor POSTs jobs here; this validates
 * each through the `Job` contract (fail-closed on the Go->Node seam) and calls `queue.add`. Keeps BullMQ's
 * Redis internals on the Node side so Go never has to replicate them.
 */
export async function startEnqueueServer(port: number, connection: { host: string; port: number }): Promise<{ server: Server; queue: Queue }> {
  const queue = new Queue(QUEUE_NAME, { connection });
  const server = createServer((req, res) => {
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
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = Job.parse(JSON.parse(body)); // reject a malformed job from the wire
        await queue.add(parsed.kind, parsed);
        res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: true, kind: parsed.kind }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
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
