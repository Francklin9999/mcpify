import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { GeneratedServerArtifact, RegistryEntry, ToolDefinition } from "@mcp/types";
import type { GeneratePersistence } from "@mcp/generator/lean";

/** Where everything lives locally. Override with MCP_FORGE_HOME (default ~/.mcp-forge). */
export function forgeHome(): string {
  return process.env["MCP_FORGE_HOME"]?.trim() || join(homedir(), ".mcp-forge");
}
function serversDir(): string {
  return join(forgeHome(), "servers");
}
function registryFile(): string {
  return join(forgeHome(), "registry.json");
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "server";
  } catch {
    return "server";
  }
}

/** Reject paths that escape the target dir (artifact file paths are codegen output, but stay defensive). */
function containedPath(targetDir: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\0")) return null;
  const resolved = resolve(targetDir, relPath);
  if (resolved !== targetDir && !resolved.startsWith(targetDir + sep)) return null;
  return resolved;
}

/** Write an artifact's files into `dir`, containing every path. Returns the count written or throws on escape. */
function writeArtifactFiles(dir: string, files: { path: string; content: string }[]): number {
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const file of files) {
    const dest = containedPath(dir, file.path);
    if (!dest) throw new Error(`refusing to write unsafe artifact path: ${file.path}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content ?? "");
    written++;
  }
  return written;
}

interface RegistryRow {
  serverId: string;
  url: string;
  title: string;
  version: number;
  tier: string;
  confidence: number;
  status: string;
  toolCount: number;
  dir: string;
  createdAt: string;
}

/**
 * Read registry rows. Distinguishes "absent" (→ []) from "present but unparseable": a corrupt registry.json is
 * RENAMED to registry.json.corrupt-<ts> and a warning is printed, so the next write can't silently destroy the
 * user's prior history by overwriting an unreadable file with a single fresh row.
 */
function readRegistry(): RegistryRow[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegistryRow[]) : [];
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
      console.error(`[mcp-forge] registry.json was unparseable; backed it up to ${backup} and started fresh.`);
    } catch {
      /* best effort: if we can't back it up, still don't crash */
    }
    return [];
  }
}

/**
 * Atomically reserve a unique server directory `<slug>-v<n>` using a non-recursive mkdir as a lock: if the dir
 * already exists (another generation of the same URL), bump the version and retry. This guarantees concurrent
 * generations get distinct dirs instead of silently overwriting each other's files.
 */
function reserveServerDir(url: string): { dir: string; version: number } {
  const base = serversDir();
  mkdirSync(base, { recursive: true });
  const slug = slugFromUrl(url);
  const maxKnown = readRegistry()
    .filter((r) => r.url === url)
    .reduce((mx, r) => Math.max(mx, r.version), 0);
  let version = maxKnown + 1;
  for (let i = 0; i < 10_000; i++) {
    const dir = join(base, `${slug}-v${version}`);
    try {
      mkdirSync(dir); // non-recursive: throws EEXIST if the dir is already reserved/present
      return { dir, version };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        version++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not reserve a server directory for ${url} (too many existing versions)`);
}

// Serialize registry appends within this process: writeRegistry is a read-modify-write, so concurrent
// generations would otherwise lose each other's rows (second writeFileSync clobbers the first).
let writeChain: Promise<void> = Promise.resolve();
function appendRegistryRow(row: RegistryRow): Promise<void> {
  const next = writeChain.then(() => {
    const rows = readRegistry();
    rows.push(row);
    mkdirSync(forgeHome(), { recursive: true });
    writeFileSync(registryFile(), JSON.stringify(rows, null, 2));
  });
  writeChain = next.catch(() => {}); // keep the chain alive even if one append throws
  return next;
}

/**
 * Filesystem persistence - the standalone replacement for the web product's Postgres + R2 adapters. Same
 * `GeneratePersistence` port the generator core already depends on, so generate() runs UNCHANGED; we just
 * write the artifact's files to ~/.mcp-forge/servers/<slug>-v<n>/ and append a row to registry.json.
 */
export class FsPersistence implements GeneratePersistence {
  /** serverId -> the reserved dir + version for one generation, shared across nextServer/saveArtifact. */
  private readonly meta = new Map<string, { version: number; dir: string }>();

  async nextServer(url: string): Promise<{ serverId: string; version: number }> {
    const { dir, version } = reserveServerDir(url); // atomically reserves the dir (collision-proof)
    const serverId = randomUUID();
    this.meta.set(serverId, { version, dir });
    return { serverId, version };
  }

  async saveArtifact(artifact: GeneratedServerArtifact): Promise<string> {
    const dir = this.meta.get(artifact.serverId)?.dir ?? join(serversDir(), `${slugFromUrl(artifact.serverId)}-v${artifact.version}`);
    writeArtifactFiles(dir, artifact.files);
    return dir; // used as artifactUrl by writeRegistry; for the local product it's the directory path
  }

  async writeRegistry(entry: RegistryEntry, tools: ToolDefinition[], artifactUrl: string): Promise<void> {
    await appendRegistryRow({
      serverId: entry.serverId,
      url: entry.url,
      title: entry.title,
      version: entry.currentVersion,
      tier: entry.tier,
      confidence: entry.confidence,
      status: entry.status,
      toolCount: tools.length,
      dir: artifactUrl,
      createdAt: new Date().toISOString(),
    });
  }

  /** The directory a just-generated server's files were written to (for reporting back to the caller). */
  dirFor(serverId: string): string | undefined {
    return this.meta.get(serverId)?.dir;
  }
}

export function installHint(dir: string, hasInstallSh: boolean): string {
  if (!hasInstallSh) return `cd "${dir}" && npm install && npm run build`;
  return process.platform === "win32"
    ? `powershell -ExecutionPolicy Bypass -File "${join(dir, "install.ps1")}"`
    : `bash "${join(dir, "install.sh")}"`;
}
