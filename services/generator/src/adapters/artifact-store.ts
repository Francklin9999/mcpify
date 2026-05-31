import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { r2Keys, type GeneratedServerArtifact } from "@mcp/types";

/** Stores a generated artifact and returns its URL. R2 in prod; filesystem for local/dev + tests. */
export interface ArtifactStore {
  save(artifact: GeneratedServerArtifact): Promise<string>;
}

/**
 * Filesystem-backed store (dev/test). Writes each file under `<root>/<r2Key>/...` and returns a file:// URL
 * (a valid URL for the `artifactUrl` contract field). The prod R2 adapter implements the same interface.
 */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async save(artifact: GeneratedServerArtifact): Promise<string> {
    const key = r2Keys.artifact(artifact.serverId, artifact.version); // artifacts/{serverId}/{version}.zip
    const dir = `${this.root}/${key}`;
    for (const file of artifact.files) {
      const dest = `${dir}/${file.path}`;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content);
    }
    return pathToFileURL(dir).href;
  }
}
