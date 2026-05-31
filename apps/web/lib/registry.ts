import { and, desc, eq, ilike, or } from "drizzle-orm";
import { serverVersions, servers } from "@mcp/db";
import { RegistryEntry, ServerTier, ServerVersion, type RegistryEntry as RegistryEntryT, type ServerTier as ServerTierT, type ServerVersion as ServerVersionT } from "@mcp/types";
import { atlasDocToEntry, atlasDocToVersion, filterEntries } from "@/lib/atlas-catalog";
import { db } from "@/lib/db";
import { toolsCollection } from "@/lib/mongo";
import { sampleRegistry, sampleVersions } from "@/lib/sample-data";

type SearchParams = {
  tier?: string | null;
  q?: string | null;
};

function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeRegistryRow(row: any): RegistryEntryT | null {
  const parsed = RegistryEntry.safeParse({
    serverId: row.serverId,
    url: row.url,
    title: row.title,
    tier: row.tier,
    confidence: row.confidence,
    installCount: row.installCount,
    lastParsedAt: toIso(row.lastParsedAt),
    status: row.status,
    currentVersion: row.currentVersion,
  });
  return parsed.success ? parsed.data : null;
}

function normalizeVersionRow(row: any): ServerVersionT | null {
  const parsed = ServerVersion.safeParse({
    serverId: row.serverId,
    version: row.version,
    artifactUrl: row.artifactUrl,
    toolCount: row.toolCount,
    createdAt: toIso(row.createdAt),
    createdBy: row.createdBy,
  });
  return parsed.success ? parsed.data : null;
}

function filterSamples(params: SearchParams): RegistryEntryT[] {
  const tier = ServerTier.safeParse(params.tier).success ? (params.tier as ServerTierT) : undefined;
  const q = params.q?.trim().toLowerCase();
  return sampleRegistry
    .filter((entry) => !tier || entry.tier === tier)
    .filter((entry) => !q || entry.title.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q))
    .sort((a, b) => b.confidence - a.confidence);
}

function workingAtlasFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "active",
    "artifact.files.0": { $exists: true },
    "artifact.tools.1": { $exists: true },
    "localTest.passed": true,
    toolCount: { $gte: 2 },
    ...extra,
  };
}

async function listAtlasRegistry(params: SearchParams): Promise<RegistryEntryT[]> {
  const col = await toolsCollection();
  if (!col) return [];
  const docs = await col
    .find(workingAtlasFilter(), { projection: { _id: 0 } })
    .sort({ confidence: -1, toolCount: -1, title: 1 })
    .limit(100)
    .toArray();
  return filterEntries(
    docs.flatMap((doc) => {
      const entry = atlasDocToEntry(doc);
      return entry ? [entry] : [];
    }),
    params,
  );
}

async function getAtlasServerDetail(serverId: string): Promise<(RegistryEntryT & { versions: ServerVersionT[] }) | null> {
  const col = await toolsCollection();
  if (!col) return null;
  const doc = await col.findOne(workingAtlasFilter({ serverId }), { projection: { _id: 0 } });
  const entry = doc ? atlasDocToEntry(doc) : null;
  const version = doc ? atlasDocToVersion(doc) : null;
  if (!doc || !entry || !version) return null;
  const tools = Array.isArray(doc.tools)
    ? doc.tools.map((tool: any) => ({
        name: String(tool?.name ?? ""),
        description: String(tool?.description ?? ""),
        confidence: typeof tool?.confidence === "number" ? tool.confidence : undefined,
      }))
    : [];
  return { ...entry, versions: [version], tools } as RegistryEntryT & { versions: ServerVersionT[] };
}

export async function listRegistry(params: SearchParams = {}): Promise<RegistryEntryT[]> {
  const atlas = await listAtlasRegistry(params).catch(() => []);
  if (atlas.length) return atlas.sort((a, b) => b.confidence - a.confidence);
  if (!hasDatabase()) return filterSamples(params);

  const conds = [];
  const tier = ServerTier.safeParse(params.tier);
  if (tier.success) conds.push(eq(servers.tier, tier.data));
  const q = params.q?.trim();
  if (q) conds.push(or(ilike(servers.title, `%${q}%`), ilike(servers.url, `%${q}%`)));

  const rows = await db()
    .select()
    .from(servers)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(servers.confidence))
    .limit(100);
  return rows.flatMap((row) => {
    const normalized = normalizeRegistryRow(row);
    return normalized ? [normalized] : [];
  });
}

export async function getServerDetail(serverId: string): Promise<(RegistryEntryT & { versions: ServerVersionT[] }) | null> {
  if (!hasDatabase()) {
    const entry = sampleRegistry.find((item) => item.serverId === serverId);
    if (entry) return { ...entry, versions: sampleVersions.filter((version) => version.serverId === serverId) };
    return getAtlasServerDetail(serverId);
  }

  const [server] = await db().select().from(servers).where(eq(servers.serverId, serverId)).limit(1);
  const entry = server ? normalizeRegistryRow(server) : null;
  if (!entry) return getAtlasServerDetail(serverId);
  const rows = await db()
    .select()
    .from(serverVersions)
    .where(eq(serverVersions.serverId, serverId))
    .orderBy(desc(serverVersions.version));
  return {
    ...entry,
    versions: rows.flatMap((row) => {
      const normalized = normalizeVersionRow(row);
      return normalized ? [normalized] : [];
    }),
  };
}

export async function getServerVersion(serverId: string, version: number): Promise<ServerVersionT | null> {
  if (!hasDatabase()) {
    return sampleVersions.find((item) => item.serverId === serverId && item.version === version) ?? null;
  }

  const [row] = await db()
    .select()
    .from(serverVersions)
    .where(and(eq(serverVersions.serverId, serverId), eq(serverVersions.version, version)))
    .limit(1);
  return row ? normalizeVersionRow(row) : null;
}
