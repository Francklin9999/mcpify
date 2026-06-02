import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, platform } from "node:os";
import { ForgeClient, ForgeUnreachable, type JobState } from "./client.js";

/**
 * MCP Forge as an MCP server - "an MCP that creates MCPs". A thin layer on top of the existing Forge web API:
 * an agent (Claude, Codex, ...) calls forge_mcp_server(url) and gets back a brand-new MCP server (its tools +
 * a download URL) generated from that site. Read tools browse/inspect the catalog of already-forged servers.
 */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// How long forge_mcp_server will synchronously wait for a job before handing back a jobId to poll. Kept well
// under typical MCP client timeouts: generation (scrape + LLM) can take minutes, so we NEVER block open-ended.
const DEFAULT_WAIT_MS = 30_000;
const POLL_EVERY_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ServerDeps {
  client: ForgeClient;
  /** Override the wait budget (tests use a tiny value). */
  waitMs?: number;
  pollEveryMs?: number;
}

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}
function errorText(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

function slug(value: string): string {
  return String(value || "mcp-server").replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "mcp-server";
}

/**
 * Resolve an artifact file path under `targetDir`, or null if it escapes. The file list comes from whatever
 * MCP_FORGE_API_BASE points at, so a hostile/buggy Forge could send `../../.bashrc`; we reject absolute paths
 * and anything that resolves outside the target dir. This is the one security-critical line of the feature.
 */
function containedPath(targetDir: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\0")) return null;
  const resolved = resolve(targetDir, relPath);
  if (resolved !== targetDir && !resolved.startsWith(targetDir + sep)) return null;
  return resolved;
}

/** Write an artifact's files into targetDir, containing every path. Returns the count or throws on escape. */
function materializeFiles(targetDir: string, files: { path: string; content: string }[]): number {
  mkdirSync(targetDir, { recursive: true });
  let written = 0;
  for (const file of files) {
    const dest = containedPath(targetDir, file.path);
    if (!dest) throw new Error(`refusing to write unsafe artifact path: ${file.path}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content ?? "");
    written++;
  }
  return written;
}

// The done job's `result` is the GeneratedServerArtifact; it carries top-level `tools` (verified against
// generateServer + the @mcp/types artifact contract). NOTE this differs from /api/servers/:id detail, whose
// Postgres path returns no tool list - so get_mcp_server falls back, but the forge result here has tools.
function summarizeArtifact(client: ForgeClient, artifact: any): string {
  const serverId = artifact?.serverId ?? "(unknown)";
  const version = Number(artifact?.version ?? 1);
  const tools: any[] = Array.isArray(artifact?.tools) ? artifact.tools : [];
  const toolLines = tools.length
    ? tools.map((t) => `  - ${t?.name ?? "(unnamed)"}: ${String(t?.description ?? "").slice(0, 100)}`).join("\n")
    : "  (no tools detected)";
  return [
    `Forged a new MCP server.`,
    `serverId: ${serverId}  (version ${version})`,
    `tools (${tools.length}):`,
    toolLines,
    ``,
    `Download the runnable server: ${client.downloadUrl(serverId, version)}`,
    `Inspect later with get_mcp_server({ serverId: "${serverId}" }).`,
  ].join("\n");
}

// Bind registerTool to a simplified signature: the SDK's generic deep-instantiates over zod types and trips
// TS2589 under strict (same workaround the generated servers use - proven, not rediscovered).
type Register = (
  name: string,
  config: { description?: string; inputSchema?: z.ZodRawShape },
  cb: (args: Record<string, unknown>) => Promise<ToolResult>,
) => void;

export function createServer(deps: ServerDeps): McpServer {
  const { client } = deps;
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const pollEveryMs = deps.pollEveryMs ?? POLL_EVERY_MS;
  const server = new McpServer({ name: "mcp-forge", version: "0.1.0" });
  const register = server.registerTool.bind(server) as unknown as Register;

  register(
    "forge_mcp_server",
    {
      description:
        "Generate a brand-new MCP server from a website URL (MCP Forge scrapes the site, infers its tools, " +
        "and builds a runnable MCP server). Returns the new server's tools + a download URL. Generation can " +
        "take a while: this waits briefly, then returns a jobId - poll it with forge_job_status if not done yet.",
      inputSchema: {
        url: z.string().describe("The website to turn into an MCP server, e.g. https://rubygems.org"),
        legalMode: z.enum(["safe", "full_scrape", "session"]).optional().describe("Scrape mode; default 'safe'."),
        wait: z.boolean().optional().describe("Wait for completion before returning (default true, bounded ~30s)."),
      },
    },
    async (args) => {
      const url = String(args.url ?? "").trim();
      if (!url) return errorText("url is required (e.g. https://rubygems.org).");
      const legalMode = typeof args.legalMode === "string" ? args.legalMode : "safe";
      const wait = args.wait !== false;
      try {
        const { jobId } = await client.enqueueGenerate(url, legalMode);
        if (!wait) {
          return text(`Forge job started.\njobId: ${jobId}\nPoll with forge_job_status({ jobId: "${jobId}" }).`);
        }
        const deadline = Date.now() + waitMs;
        let last: JobState = { status: "queued" };
        let polls = 0;
        while (Date.now() < deadline) {
          await sleep(pollEveryMs);
          polls++;
          last = await client.jobState(jobId);
          if (last.status === "done") return text(summarizeArtifact(client, last.result));
          if (last.status === "failed") {
            return errorText(`Forge job ${jobId} failed: ${last.error ?? "unknown error"}`);
          }
        }
        // Timed out waiting. Distinguish "still queued, nobody consuming" from "running, just slow".
        if (last.status === "queued" && polls >= 2) {
          return text(
            `Forge job ${jobId} is still QUEUED after ${Math.round(waitMs / 1000)}s - it may not be getting picked up. ` +
              `Is the Forge generator worker running? Keep polling with forge_job_status({ jobId: "${jobId}" }).`,
          );
        }
        return text(
          `Forge job ${jobId} is still ${last.status} (generation takes a while). ` +
            `Poll with forge_job_status({ jobId: "${jobId}" }) to get the finished server.`,
        );
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  register(
    "forge_job_status",
    {
      description:
        "Check a forge job started by forge_mcp_server. Returns the finished MCP server (tools + download URL) " +
        "when done, or its current status (queued/running/failed) otherwise.",
      inputSchema: { jobId: z.string().describe("The jobId returned by forge_mcp_server.") },
    },
    async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) return errorText("jobId is required.");
      try {
        const state = await client.jobState(jobId);
        if (state.status === "done") return text(summarizeArtifact(client, state.result));
        if (state.status === "failed") return errorText(`Forge job ${jobId} failed: ${state.error ?? "unknown error"}`);
        const hint =
          state.status === "queued"
            ? " (if it stays queued, check that the Forge generator worker is running)"
            : "";
        return text(`Forge job ${jobId} is ${state.status}${hint}. Poll again shortly.`);
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  register(
    "search_mcp_catalog",
    {
      description:
        "Search the catalog of MCP servers MCP Forge has already generated (by name/url). Use this before " +
        "forging to reuse an existing server for a site.",
      inputSchema: {
        q: z.string().optional().describe("Match against server title/url."),
        tier: z.enum(["curated", "auto_gen"]).optional(),
      },
    },
    async (args) => {
      try {
        const rows = await client.listRegistry({
          q: typeof args.q === "string" ? args.q : undefined,
          tier: typeof args.tier === "string" ? args.tier : undefined,
        });
        if (!rows.length) return text("No servers in the catalog match that query.");
        const lines = rows
          .slice(0, 40)
          .map((r) => `- ${r.title ?? r.url} [${r.serverId}] tools=${r.toolCount ?? "?"} conf=${r.confidence ?? "?"} ${r.url}`);
        return text(`${rows.length} server(s):\n${lines.join("\n")}`);
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  register(
    "get_mcp_server",
    {
      description: "Get details (tools, versions, confidence, download URL) for one MCP server in the catalog by its serverId.",
      inputSchema: { serverId: z.string().describe("The server's id (from search_mcp_catalog or forge_mcp_server).") },
    },
    async (args) => {
      const serverId = String(args.serverId ?? "").trim();
      if (!serverId) return errorText("serverId is required.");
      try {
        const detail = await client.serverDetail(serverId);
        if (!detail) return errorText(`No server found with id ${serverId}.`);
        const version = Number(detail.currentVersion ?? detail.versions?.[0]?.version ?? 1);
        const tools: any[] = Array.isArray(detail.tools) ? detail.tools : [];
        const toolLines = tools.length
          ? tools.map((t) => `  - ${t?.name ?? "(unnamed)"}: ${String(t?.description ?? "").slice(0, 100)}`).join("\n")
          : "  (tool list not available in the catalog summary)";
        return text(
          [
            `${detail.title ?? detail.url}  [${serverId}]`,
            `url: ${detail.url}   tier: ${detail.tier}   status: ${detail.status}   confidence: ${detail.confidence}`,
            `tools (${tools.length}):`,
            toolLines,
            ``,
            `Download: ${client.downloadUrl(serverId, version)}`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  register(
    "download_mcp_server",
    {
      description:
        "Get the download URL + summary for a generated MCP server's runnable artifact (so you can save and " +
        "install it). Returns the URL and tool list rather than dumping the files.",
      inputSchema: {
        serverId: z.string(),
        version: z.number().optional().describe("Defaults to the server's current version."),
      },
    },
    async (args) => {
      const serverId = String(args.serverId ?? "").trim();
      if (!serverId) return errorText("serverId is required.");
      try {
        const detail = await client.serverDetail(serverId);
        if (!detail) return errorText(`No server found with id ${serverId}.`);
        const version = typeof args.version === "number" ? args.version : Number(detail.currentVersion ?? 1);
        const url = client.downloadUrl(serverId, version);
        return text(
          [
            `Download URL for ${detail.title ?? serverId} (v${version}):`,
            `  ${url}`,
            ``,
            `It returns a JSON artifact (runnable files + install scripts). Save it, then run install.sh / ` +
              `install.ps1 to register it into your MCP clients, or add ?format=zip to the URL for a zip. ` +
              `Or use install_mcp_server to write it to disk ready to install.`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  register(
    "install_mcp_server",
    {
      description:
        "Write a generated MCP server's runnable files to a local directory, ready to install. Materializes " +
        "the artifact (server source + package.json + the install.sh/install.ps1/mcp-register.mjs scripts) " +
        "to disk and returns the directory + the one command to finish installing it into your MCP clients. " +
        "Does NOT run the installer for you (it builds with npm and edits client configs - run it yourself).",
      inputSchema: {
        serverId: z.string(),
        version: z.number().optional().describe("Defaults to the server's current version."),
        dir: z.string().optional().describe("Target directory (absolute). Defaults to ~/.mcp-forge/servers/<id>-v<n>."),
      },
    },
    async (args) => {
      const serverId = String(args.serverId ?? "").trim();
      if (!serverId) return errorText("serverId is required.");
      try {
        const detail = await client.serverDetail(serverId);
        const version = typeof args.version === "number" ? args.version : Number(detail?.currentVersion ?? 1);
        const artifact = await client.fetchArtifact(serverId, version);
        const targetDir =
          typeof args.dir === "string" && args.dir.trim()
            ? resolve(args.dir.trim())
            : join(process.env.MCP_FORGE_INSTALL_DIR?.trim() || join(homedir(), ".mcp-forge", "servers"), `${slug(serverId)}-v${version}`);
        const count = materializeFiles(targetDir, artifact.files);
        const hasSh = artifact.files.some((f) => f.path === "install.sh");
        const cmd =
          platform() === "win32"
            ? `powershell -ExecutionPolicy Bypass -File "${join(targetDir, "install.ps1")}"`
            : `bash "${join(targetDir, "install.sh")}"`;
        return text(
          [
            `Wrote ${count} file(s) to:`,
            `  ${targetDir}`,
            ``,
            hasSh
              ? `Finish installing (builds + registers into every detected MCP client - Claude, Codex, Cursor, ...):`
              : `Install scripts were not present in this artifact; build/run it manually:`,
            `  ${hasSh ? cmd : `cd "${targetDir}" && npm install && npm run build`}`,
            ``,
            `After it registers, restart your MCP client (in Claude Code, run /mcp) to load the new tools.`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(forgeError(err));
      }
    },
  );

  return server;
}

function forgeError(err: unknown): string {
  if (err instanceof ForgeUnreachable) return err.message;
  return `MCP Forge request failed: ${err instanceof Error ? err.message : String(err)}`;
}
