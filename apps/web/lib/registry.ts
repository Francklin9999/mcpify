import { and, desc, eq, ilike, or } from "drizzle-orm";
import { serverVersions, servers } from "@mcp/db";
import { RegistryEntry, ServerTier, ServerVersion, type RegistryEntry as RegistryEntryT, type ServerTier as ServerTierT, type ServerVersion as ServerVersionT } from "@mcp/types";
import { db } from "@/lib/db";
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
  return rows.flatMap((row) => {
    const normalized = normalizeRegistryRow(row);
    return normalized ? [normalized] : [];
  });
}

export async function getServerDetail(serverId: string): Promise<(RegistryEntryT & { versions: ServerVersionT[] }) | null> {
  if (!hasDatabase()) {
    const entry = sampleRegistry.find((item) => item.serverId === serverId);
    if (!entry) return null;
    return { ...entry, versions: sampleVersions.filter((version) => version.serverId === serverId) };
  }

  const [server] = await db().select().from(servers).where(eq(servers.serverId, serverId)).limit(1);
  const entry = server ? normalizeRegistryRow(server) : null;
  if (!entry) return null;
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
