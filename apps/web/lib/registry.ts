import { and, desc, eq, ilike, or } from "drizzle-orm";
import { serverVersions, servers } from "@mcp/db";
import { RegistryEntry, ServerTier, ServerVersion, type RegistryEntry as RegistryEntryT, type ServerTier as ServerTierT, type ServerVersion as ServerVersionT } from "@mcp/types";
import { atlasDocToEntry, atlasDocToVersion, filterEntries, mergeRegistry } from "@/lib/atlas-catalog";
import { db } from "@/lib/db";
import { listCatalog, findCatalogEntry } from "@/lib/catalog-store";
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

// The catalog (formerly Atlas) is the browsable directory of pre-generated servers, now in Postgres.
async function listCatalogRegistry(params: SearchParams): Promise<RegistryEntryT[]> {
  const docs = await listCatalog({ q: params.q, limit: 100 }).catch(() => []);
  return filterEntries(
    docs.flatMap((doc) => {
      const entry = atlasDocToEntry(doc);
      return entry ? [entry] : [];
    }),
    params,
  );
}

async function getCatalogServerDetail(serverId: string): Promise<(RegistryEntryT & { versions: ServerVersionT[] }) | null> {
  const doc = await findCatalogEntry(serverId).catch(() => null);
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
  const generated = rows.flatMap((row) => {
    const normalized = normalizeRegistryRow(row);
    return normalized ? [normalized] : [];
  });
  // Show BOTH the user's generated servers AND the catalog directory, deduped by url (generated wins).
  const catalogEntries = await listCatalogRegistry(params);
  return mergeRegistry(generated, catalogEntries).sort((a, b) => b.confidence - a.confidence);
}

export async function getServerDetail(serverId: string): Promise<(RegistryEntryT & { versions: ServerVersionT[] }) | null> {
  if (!hasDatabase()) {
    const entry = sampleRegistry.find((item) => item.serverId === serverId);
    if (entry) return { ...entry, versions: sampleVersions.filter((version) => version.serverId === serverId) };
    return getCatalogServerDetail(serverId);
  }

  const [server] = await db().select().from(servers).where(eq(servers.serverId, serverId)).limit(1);
  const entry = server ? normalizeRegistryRow(server) : null;
  if (!entry) return getCatalogServerDetail(serverId);
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
