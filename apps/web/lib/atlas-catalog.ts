import type { RegistryEntry, ServerVersion } from "@mcp/types";

/**
 * Pure adapters between MongoDB Atlas catalog documents and the registry/detail shapes the web app
 * already renders. Kept free of I/O so they are unit-testable without a live MongoDB. The actual
 * Atlas reads/writes live in registry.ts / server-detail.ts / api/discover and are always best-effort:
 * when MONGODB_URI is unset (the default), none of this runs and the app behaves exactly as before.
 */

export type AtlasDoc = Record<string, any>;

const TIERS = new Set<RegistryEntry["tier"]>(["curated", "auto_gen"]);
const STATUSES = new Set<RegistryEntry["status"]>(["active", "degraded", "broken", "regenerating"]);

/** Normalize a url or domain into a dedup key: drop scheme, leading www., trailing slash, lowercase. */
export function catalogKey(value: string | undefined | null): string {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/** Best-effort domain extraction for the discover write path (e.g. "https://www.npmjs.com/x" -> "npmjs.com"). */
export function domainFromUrl(value: string | undefined | null): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return catalogKey(value).split("/")[0] ?? "";
  }
}

function originOf(doc: AtlasDoc, domain: string): string {
  if (typeof doc?.origin === "string" && doc.origin) return doc.origin;
  if (typeof doc?.url === "string" && doc.url) return doc.url;
  return domain ? `https://${domain}` : "";
}

function versionOf(doc: AtlasDoc): number {
  const v = Number(doc?.currentVersion ?? doc?.version ?? doc?.artifact?.version ?? 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function toolCountOf(doc: AtlasDoc): number {
  if (Array.isArray(doc?.tools)) return doc.tools.length;
  if (typeof doc?.toolCount === "number") return doc.toolCount;
  return 0;
}

/** Map a MongoDB Atlas catalog document to a RegistryEntry, or null if it lacks a usable identity. */
export function atlasDocToEntry(doc: AtlasDoc): RegistryEntry | null {
  const domain = typeof doc?.domain === "string" ? doc.domain : "";
  const origin = originOf(doc, domain);
  const id = (typeof doc?.serverId === "string" && doc.serverId) || domain;
  if (!id || !origin) return null;

  return {
    serverId: id,
    url: origin,
    title: (typeof doc?.title === "string" && doc.title) || domain || origin,
    tier: TIERS.has(doc?.tier) ? doc.tier : "auto_gen",
    confidence: typeof doc?.confidence === "number" ? doc.confidence : 0,
    installCount: typeof doc?.installCount === "number" ? doc.installCount : 0,
    lastParsedAt:
      typeof doc?.updatedAt === "string"
        ? doc.updatedAt
        : typeof doc?.createdAt === "string"
          ? doc.createdAt
          : new Date(0).toISOString(),
    status: STATUSES.has(doc?.status) ? doc.status : "active",
    currentVersion: versionOf(doc),
  };
}

/** Merge Postgres registry entries with Atlas catalog entries, deduped by normalized url. Postgres wins. */
export function mergeRegistry(pg: RegistryEntry[], atlas: RegistryEntry[]): RegistryEntry[] {
  const seen = new Set(pg.map((e) => catalogKey(e.url)));
  const merged = [...pg];
  for (const e of atlas) {
    const key = catalogKey(e.url);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(e);
  }
  return merged;
}

/** In-memory tier/q filter mirroring listRegistry's SQL semantics, applied to Atlas-sourced entries. */
export function filterEntries(
  entries: RegistryEntry[],
  args: { tier?: string | null; q?: string | null },
): RegistryEntry[] {
  let out = entries;
  if (args.tier) out = out.filter((e) => e.tier === args.tier);
  if (args.q) {
    const q = args.q.toLowerCase();
    out = out.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
  }
  return out;
}

export type AtlasServerDetail = {
  id: string;
  url: string;
  title: string;
  tier: string;
  status: string;
  confidence: number;
  currentVersion: number;
  tools: { name: string; description: string; confidence: number }[];
  versions: number[];
  source: "atlas";
  downloadUrl: string;
  downloadName: string;
};

/** Build a server-detail view from an Atlas catalog document (download routes to /api/atlas/download). */
export function atlasDocToDetail(doc: AtlasDoc): AtlasServerDetail | null {
  const entry = atlasDocToEntry(doc);
  if (!entry) return null;
  const domain = typeof doc?.domain === "string" ? doc.domain : "";
  const tools = Array.isArray(doc?.tools)
    ? doc.tools.map((t: any) => ({
        name: String(t?.name ?? ""),
        description: String(t?.description ?? ""),
        confidence: typeof t?.confidence === "number" ? t.confidence : 0,
      }))
    : [];
  const selector = domain
    ? `domain=${encodeURIComponent(domain)}`
    : `serverId=${encodeURIComponent(entry.serverId)}`;
  return {
    id: entry.serverId,
    url: entry.url,
    title: entry.title,
    tier: entry.tier,
    status: entry.status,
    confidence: entry.confidence,
    currentVersion: entry.currentVersion,
    tools,
    versions: [entry.currentVersion],
    source: "atlas",
    downloadUrl: `/api/atlas/download?${selector}&version=${entry.currentVersion}`,
    downloadName: `${(domain || entry.serverId).replace(/[^a-z0-9.-]/gi, "-")}-v${entry.currentVersion}.artifact.json`,
  };
}

/** Build the version row shape the existing server detail page already renders. */
export function atlasDocToVersion(doc: AtlasDoc): ServerVersion | null {
  const entry = atlasDocToEntry(doc);
  if (!entry) return null;
  return {
    serverId: entry.serverId,
    version: entry.currentVersion,
    artifactUrl: `https://atlas.local/api/atlas/download?serverId=${encodeURIComponent(entry.serverId)}&version=${entry.currentVersion}`,
    toolCount: toolCountOf(doc),
    createdAt: entry.lastParsedAt,
    createdBy: "atlas-seed",
  };
}
