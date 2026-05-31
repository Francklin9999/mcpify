import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contributions } from "@mcp/db";
import type { CaptureBundle } from "@mcp/types";
import { db } from "@/lib/db";

const DEFAULT_BUNDLE_DIR = "/tmp/mcp-capture-bundles";

export async function storeContribution(serverId: string, bundle: CaptureBundle): Promise<{ bundleRef: string }> {
  const bundleRef = `bundles/${bundle.bundleId}.json`;
  const root = process.env.CAPTURE_BUNDLE_DIR ?? DEFAULT_BUNDLE_DIR;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${bundle.bundleId}.json`), JSON.stringify(bundle, null, 2));

  if (process.env.DATABASE_URL) {
    await db().insert(contributions).values({
      serverId,
      bundleRef,
      contributedBy: "extension",
      status: "pending",
    });
  }

  return { bundleRef };
}
