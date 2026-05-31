import { createServer, type Server } from "node:http";
import { Queue } from "bullmq";
import { Job, QUEUE_NAME } from "@mcp/types";

/**
 * Thin enqueue shim (the cross-language producer path). The Go monitor POSTs jobs here; this validates
 * each through the `Job` contract (fail-closed on the Go->Node seam) and calls `queue.add`. Keeps BullMQ's
 * Redis internals on the Node side so Go never has to replicate them.
 */
export function startEnqueueServer(port: number, connection: { host: string; port: number }): { server: Server; queue: Queue } {
  const queue = new Queue(QUEUE_NAME, { connection });
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/enqueue") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = Job.parse(JSON.parse(body)); // reject a malformed job from the wire
        await queue.add(parsed.kind, parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, kind: parsed.kind }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
  });
  server.listen(port);
  return { server, queue };
}
