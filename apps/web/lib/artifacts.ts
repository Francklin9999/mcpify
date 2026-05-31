import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GeneratedServerArtifact, type GeneratedServerArtifact as GeneratedServerArtifactT } from "@mcp/types";

async function collectFiles(root: string, dir = root): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(root, fullPath);
      if (!entry.isFile()) return [];
      return [{ path: relative(root, fullPath), content: await readFile(fullPath, "utf8") }];
    }),
  );
  return files.flat();
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

  const files = await collectFiles(root);
  const configSnippet = files.find((file) => file.path === "claude_desktop_config.json")?.content ?? "{}";
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
