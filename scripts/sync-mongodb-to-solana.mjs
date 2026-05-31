import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { loadKeypair, makeConnection, publishServer } from "../packages/solana/dist/src/index.js";

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();

const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const INCLUDE_BROKEN = process.argv.includes("--include-broken") || process.env.INCLUDE_BROKEN === "1";
const MAX_RECORDS = Number(process.env.SYNC_LIMIT ?? 0);

function uuidFrom(text) {
  const hex = createHash("sha256").update(String(text)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function catalogKey(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function domainFromUrl(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return catalogKey(value).split("/")[0] ?? "";
  }
}

function originOf(doc) {
  if (typeof doc?.origin === "string" && doc.origin) return doc.origin;
  if (typeof doc?.url === "string" && doc.url) return doc.url;
  if (typeof doc?.domain === "string" && doc.domain) return `https://${doc.domain}`;
  return "";
}

function toolNamesOf(doc) {
  const tools = Array.isArray(doc?.tools)
    ? doc.tools
    : Array.isArray(doc?.artifact?.tools)
      ? doc.artifact.tools
      : [];
  return [...new Set(tools.map((tool) => String(tool?.name ?? "").trim()).filter(Boolean))];
}

function confidenceOf(doc) {
  const raw = Number(doc?.confidence);
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
}

function entryFromDoc(doc) {
  const url = originOf(doc);
  const domain = typeof doc?.domain === "string" && doc.domain ? doc.domain : domainFromUrl(url);
  const identity = typeof doc?.serverId === "string" && doc.serverId
    ? doc.serverId
    : domain || url || String(doc?._id ?? "");
  const serverId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity)
    ? identity
    : uuidFrom(identity);
  const title = (typeof doc?.title === "string" && doc.title) || domain || url;
  const toolNames = toolNamesOf(doc);

  if (!url || !title || toolNames.length === 0) {
    return {
      skipReason: `missing ${[
        !url && "url",
        !title && "title",
        toolNames.length === 0 && "tools",
      ].filter(Boolean).join("/")}`,
    };
  }

  return {
    serverId,
    url,
    title,
    toolNames,
    confidence: confidenceOf(doc),
  };
}

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is not set. Add it to .env or the environment.");

  const authority = DRY_RUN ? null : loadKeypair();
  if (!DRY_RUN && !authority) {
    throw new Error("SOLANA_REGISTRY_KEYPAIR is not set. Set it to a keypair JSON path or byte array, or use --dry-run.");
  }

  const client = new MongoClient(uri);
  await client.connect();

  const stats = { published: 0, skipped: 0, failed: 0 };
  try {
    const db = client.db(process.env.MONGODB_DATABASE || "mcp_forge");
    const col = db.collection(process.env.MONGODB_COLLECTION || "tools");
    const filter = INCLUDE_BROKEN ? {} : { status: { $ne: "broken" } };
    const cursor = col.find(filter).sort({ domain: 1, title: 1 });
    if (MAX_RECORDS > 0) cursor.limit(MAX_RECORDS);

    const connection = DRY_RUN ? null : makeConnection();
    for await (const doc of cursor) {
      const entry = entryFromDoc(doc);
      const label = doc.domain || doc.title || doc.url || doc._id;
      if ("skipReason" in entry) {
        stats.skipped += 1;
        console.log(`skip ${label}: ${entry.skipReason}`);
        continue;
      }

      if (DRY_RUN) {
        stats.published += 1;
        console.log(`dry-run ${label}: ${entry.toolNames.length} tool(s), serverId=${entry.serverId}`);
        continue;
      }

      try {
        const tx = await publishServer(connection, authority, entry);
        stats.published += 1;
        console.log(`ok ${label}: ${entry.toolNames.length} tool(s), tx=${tx}`);
      } catch (err) {
        stats.failed += 1;
        console.error(`fail ${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.close();
  }

  console.log(JSON.stringify({
    mode: DRY_RUN ? "dry-run" : "publish",
    ...stats,
  }, null, 2));

  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
