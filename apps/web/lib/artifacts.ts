import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GeneratedServerArtifact, type GeneratedServerArtifact as GeneratedServerArtifactT } from "@mcp/types";

const MAX_ARTIFACT_FILES = 64;
const MAX_ARTIFACT_BYTES = 2_000_000;
const MAX_ARTIFACT_DEPTH = 8;

export class ArtifactLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactLimitError";
  }
}

async function collectFiles(root: string): Promise<{ path: string; content: string }[]> {
  const state = { files: 0, bytes: 0 };
  const files: { path: string; content: string }[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_ARTIFACT_DEPTH) throw new ArtifactLimitError("artifact directory is too deep");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      state.files += 1;
      if (state.files > MAX_ARTIFACT_FILES) throw new ArtifactLimitError("artifact has too many files");
      const info = await stat(fullPath);
      state.bytes += info.size;
      if (state.bytes > MAX_ARTIFACT_BYTES) throw new ArtifactLimitError("artifact is too large");
      files.push({ path: relative(root, fullPath), content: await readFile(fullPath, "utf8") });
    }
  }

  return files;
}

export async function artifactFromFileUrl(
  artifactUrl: string,
  serverId: string,
  version: number,
): Promise<GeneratedServerArtifactT | null> {
  if (!artifactUrl.startsWith("file://")) return null;
  const root = fileURLToPath(artifactUrl);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return null;

  let files: { path: string; content: string }[];
  try {
    files = await collectFiles(root);
  } catch (err) {
    if (err instanceof ArtifactLimitError) throw err;
    return null;
  }
  if (!files.length) return null;
  const configSnippet = files.find((file) => file.path === "claude_code_config.json")?.content ?? "{}";
  const parsed = GeneratedServerArtifact.safeParse({
    serverId,
    version,
    files,
    entrypoint: files.some((file) => file.path === "server.ts") ? "server.ts" : files[0]?.path ?? "",
    configSnippet,
    artifactUrl: pathToFileURL(root).href,
  });
  return parsed.success ? parsed.data : null;
}
