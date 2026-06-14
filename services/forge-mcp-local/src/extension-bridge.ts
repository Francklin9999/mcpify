import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Localhost bridge between the urlmcp MCP server (this Node process) and the urlmcp Chrome extension running inside
 * the user's REAL, already-signed-in browser. A Chrome extension can't be an MCP server and can't be connected TO,
 * so the model is inverted: this process hosts a tiny HTTP server on 127.0.0.1 and the extension dials OUT to it,
 * long-polling for capture commands and POSTing back results.
 *
 *   MCP server  ──127.0.0.1 HTTP──▶  (extension dials out)  ──chrome.debugger (CDP)──▶  real logged-in tab
 *
 * Endpoints (all under /urlmcp, bound to loopback only):
 *   GET  /hello   extension announces itself          -> { ok, bridge }
 *   GET  /next    long-poll for the next command      -> { id, type:"capture", url, ... } | { none:true }
 *   POST /result  return a finished capture           <- { id, ok, url, title, html, network[] } | { id, ok:false, error }
 *
 * No third-party WebSocket dependency: an HTTP long-poll is plenty for the one-command-at-a-time capture cadence
 * and keeps the bundle dependency-free. Bound to 127.0.0.1 so nothing off-machine can reach it.
 */

export interface ExtCaptureCommand {
  id: string;
  type: "capture";
  url: string;
  settleMs: number;
  navTimeoutMs: number;
  interact: boolean;
  /** When true, the extension waits (up to authTimeoutMs) for the user to clear a sign-in/CAPTCHA wall before capturing. */
  authHandoff: boolean;
  authTimeoutMs: number;
}

export interface ExtCaptureResult {
  url: string;
  title: string;
  html: string;
  network: unknown[];
}

const PORT = Number(process.env["FORGE_EXT_PORT"]) || 47_900;
const HOST = "127.0.0.1";
const LONGPOLL_MS = 25_000; // hold /next this long before returning {none} so the extension re-polls (and the SW stays alive)
const MAX_BODY = 24 * 1024 * 1024; // result bodies carry full HTML + JSON response bodies; generous loopback cap
const SEEN_FRESH_MS = 30_000; // the extension is "connected" if it polled within this window

type Pending = { resolve: (r: ExtCaptureResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Waiter = (cmd: ExtCaptureCommand | null) => void;

export class ExtensionBridge {
  private server?: Server;
  private port = PORT;
  private lastSeen = 0;
  private readonly queue: ExtCaptureCommand[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly connectResolvers: Array<() => void> = [];

  /** Start the loopback HTTP server (idempotent). Rejects if the port is already taken. */
  start(): Promise<{ port: number }> {
    if (this.server) return Promise.resolve({ port: this.port });
    const server = createServer((req, res) => this.onRequest(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, HOST, () => {
        server.removeListener("error", reject);
        resolve({ port: this.port });
      });
    });
  }

  /** True if the extension has polled us within the freshness window (i.e. it's loaded and connected). */
  isConnected(): boolean {
    return Date.now() - this.lastSeen < SEEN_FRESH_MS;
  }

  /** Resolve true once the extension is connected, or false at the deadline. */
  waitForExtension(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        const i = this.connectResolvers.indexOf(fire);
        if (i >= 0) this.connectResolvers.splice(i, 1);
        resolve(ok);
      };
      const fire = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.connectResolvers.push(fire);
    });
  }

  /** Queue a capture for the extension and resolve with its result (or reject on error / timeout). */
  capture(
    url: string,
    opts: { settleMs: number; navTimeoutMs: number; interact: boolean; authHandoff?: boolean; authTimeoutMs?: number; timeoutMs?: number },
  ): Promise<ExtCaptureResult> {
    const id = randomUUID();
    const authHandoff = opts.authHandoff ?? false;
    const authTimeoutMs = opts.authTimeoutMs ?? 300_000;
    const cmd: ExtCaptureCommand = { id, type: "capture", url, settleMs: opts.settleMs, navTimeoutMs: opts.navTimeoutMs, interact: opts.interact, authHandoff, authTimeoutMs };
    // The capture-level timeout must outlast the auth wait, or a legit sign-in pause would look like a hang.
    const timeoutMs = opts.timeoutMs ?? opts.navTimeoutMs + opts.settleMs + (authHandoff ? authTimeoutMs : 0) + 15_000;
    return new Promise<ExtCaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension capture timed out after ${timeoutMs}ms (is the urlmcp extension loaded and the browser open?)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.enqueue(cmd);
    });
  }

  async close(): Promise<void> {
    for (const w of this.waiters.splice(0)) w(null);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closed"));
    }
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  // --- internals ---

  private enqueue(cmd: ExtCaptureCommand): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(cmd);
    else this.queue.push(cmd);
  }

  private markSeen(): void {
    this.lastSeen = Date.now();
    for (const r of this.connectResolvers.splice(0)) r();
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || "";
    if (req.method === "GET" && url.startsWith("/urlmcp/hello")) {
      this.markSeen();
      return this.json(res, { ok: true, bridge: "urlmcp" });
    }
    if (req.method === "GET" && url.startsWith("/urlmcp/next")) {
      this.markSeen();
      return this.handleNext(res);
    }
    if (req.method === "POST" && url.startsWith("/urlmcp/result")) {
      this.markSeen();
      return this.handleResult(req, res);
    }
    res.writeHead(404).end();
  }

  private handleNext(res: ServerResponse): void {
    const queued = this.queue.shift();
    if (queued) return this.json(res, queued);
    // Long-poll: hold the response until a command arrives or the poll window elapses.
    let settled = false;
    const waiter: Waiter = (cmd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.json(res, cmd ?? { none: true });
    };
    const timer = setTimeout(() => {
      const i = this.waiters.indexOf(waiter);
      if (i >= 0) this.waiters.splice(i, 1);
      waiter(null);
    }, LONGPOLL_MS);
    res.on("close", () => {
      const i = this.waiters.indexOf(waiter);
      if (i >= 0) this.waiters.splice(i, 1);
      clearTimeout(timer);
      settled = true;
    });
    this.waiters.push(waiter);
  }

  private handleResult(req: IncomingMessage, res: ServerResponse): void {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return this.json(res, { ok: false, error: "bad json" }, 400);
      }
      const id = String(body?.id || "");
      const p = this.pending.get(id);
      if (!p) return this.json(res, { ok: true, stale: true }); // late/duplicate result — ack and drop
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (body.ok) {
        p.resolve({ url: String(body.url || ""), title: String(body.title || ""), html: String(body.html || ""), network: Array.isArray(body.network) ? body.network : [] });
      } else {
        p.reject(new Error(String(body.error || "extension capture failed")));
      }
      this.json(res, { ok: true });
    });
    req.on("error", () => this.json(res, { ok: false, error: "stream error" }, 400));
  }

  private json(res: ServerResponse, obj: unknown, status = 200): void {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "content-type": "application/json", "content-length": String(buf.length) });
    res.end(buf);
  }
}

let shared: ExtensionBridge | undefined;
let startPromise: Promise<ExtensionBridge> | undefined;

/** Lazily start (once) and return the process-wide extension bridge. */
export async function getSharedBridge(): Promise<ExtensionBridge> {
  if (shared) return shared;
  if (!startPromise) {
    const bridge = new ExtensionBridge();
    startPromise = bridge.start().then(() => (shared = bridge));
  }
  return startPromise;
}
