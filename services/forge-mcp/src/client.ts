/**
 * Thin HTTP client over the existing MCP Forge web API (the "layer on top"): the meta-MCP server calls these
 * rather than re-implementing the generate pipeline (which needs Postgres + Redis + scraper + worker). All
 * methods are fail-soft and distinguish the two realistic localhost failures the agent must hear about:
 *   - the Forge API is unreachable (wrong MCP_FORGE_API_BASE / Forge not running)  -> ForgeUnreachable
 *   - a job never leaves "queued" because no generator worker is consuming the queue -> surfaced by the caller
 */

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export class ForgeUnreachable extends Error {
  constructor(public base: string, cause: unknown) {
    super(`MCP Forge API is unreachable at ${base} (${cause instanceof Error ? cause.message : String(cause)}). ` +
      `Is it running, and is MCP_FORGE_API_BASE correct?`);
    this.name = "ForgeUnreachable";
  }
}

export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobState {
  status: JobStatus;
  result?: any;
  error?: string;
}

export interface ForgeClientOpts {
  base: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

export class ForgeClient {
  private base: string;
  private fetchImpl: FetchLike;
  private timeoutMs: number;

  constructor(opts: ForgeClientOpts) {
    this.base = opts.base.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get apiBase(): string {
    return this.base;
  }

  private async call(path: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
    const url = this.base + path;
    let res;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      // Network-level failure (DNS, refused connection, timeout) = the Forge isn't reachable.
      throw new ForgeUnreachable(this.base, err);
    }
    // Read the body best-effort (JSON, falling back to text wrapped in an object).
    let body: any;
    try {
      body = await res.json();
    } catch {
      try {
        body = { error: await res.text() };
      } catch {
        body = {};
      }
    }
    return { ok: res.ok, status: res.status, body };
  }

  /** Enqueue a generate job. Returns the jobId to poll. */
  async enqueueGenerate(url: string, legalMode: string): Promise<{ jobId: string }> {
    const { ok, status, body } = await this.call("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, legalMode }),
    });
    if (!ok || !body?.jobId) {
      throw new Error(`generate request failed (HTTP ${status}): ${describeError(body)}`);
    }
    return { jobId: String(body.jobId) };
  }

  /** Poll one job's state. A missing job reports "queued" (matches the web API). */
  async jobState(jobId: string): Promise<JobState> {
    const { body } = await this.call(`/api/jobs/${encodeURIComponent(jobId)}`);
    const status = (body?.status as JobStatus) ?? "queued";
    return { status, result: body?.result, error: body?.error };
  }

  async listRegistry(params: { q?: string; tier?: string } = {}): Promise<any[]> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.tier) qs.set("tier", params.tier);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const { ok, body } = await this.call(`/api/registry${suffix}`);
    return ok && Array.isArray(body) ? body : [];
  }

  async serverDetail(serverId: string): Promise<any | null> {
    const { ok, body } = await this.call(`/api/servers/${encodeURIComponent(serverId)}`);
    return ok ? body : null;
  }

  /** The browser-facing URL where a server's artifact can be downloaded (returned to the agent, not fetched). */
  downloadUrl(serverId: string, version: number): string {
    return `${this.base}/api/servers/${encodeURIComponent(serverId)}/download/${version}`;
  }
}

function describeError(body: any): string {
  if (!body) return "no response body";
  if (typeof body.error === "string") return body.error;
  if (body.error) return JSON.stringify(body.error);
  return JSON.stringify(body);
}
