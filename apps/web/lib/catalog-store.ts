import { and, desc, or, sql } from "drizzle-orm";
import { catalog } from "@mcp/db";
import { db } from "@/lib/db";
import { bodyToColumns, type AtlasDoc } from "@/lib/atlas-catalog";

/**
 * Postgres-backed catalog store - the browsable directory of pre-generated MCP servers. Rows are shaped into
 * the AtlasDoc form for atlas-catalog.ts. The heavy `artifact` blob is loaded only on the download path.
 */

/** True when a Postgres connection string is configured (mirrors the old "Mongo configured" gate). */
export function catalogConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// Listing/detail columns - everything EXCEPT the runnable artifact blob.
const listingColumns = {
  domain: catalog.domain,
  serverId: catalog.serverId,
  origin: catalog.origin,
  title: catalog.title,
  tier: catalog.tier,
  confidence: catalog.confidence,
  installCount: catalog.installCount,
  status: catalog.status,
  version: catalog.version,
  toolCount: catalog.toolCount,
  localTestPassed: catalog.localTestPassed,
  tags: catalog.tags,
  tools: catalog.tools,
  createdAt: catalog.createdAt,
  updatedAt: catalog.updatedAt,
};

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/** Shape a catalog row into the AtlasDoc form the atlas-catalog.ts adapters already understand. */
function rowToDoc(row: Record<string, any>): AtlasDoc {
  return {
    domain: row.domain,
    serverId: row.serverId ?? undefined,
    origin: row.origin,
    url: row.origin,
    title: row.title,
    tier: row.tier,
    confidence: row.confidence,
    installCount: row.installCount,
    status: row.status,
    version: row.version,
    currentVersion: row.version,
    toolCount: row.toolCount,
    tools: Array.isArray(row.tools) ? row.tools : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    updatedAt: iso(row.updatedAt),
    createdAt: iso(row.createdAt),
  };
}

// A catalog entry is "working" (safe to surface/download) when it's active, locally verified, has a stored
// runnable artifact, and exposes at least 2 tools - the SQL equivalent of the old Mongo working filter.
function workingPredicate() {
  return and(
    sql`${catalog.status} = 'active'`,
    sql`${catalog.localTestPassed} = true`,
    sql`${catalog.toolCount} >= 2`,
    sql`${catalog.artifact} IS NOT NULL`,
  );
}

/** List catalog entries (no artifact). `all` drops the working filter; `q` matches domain/title/origin. */
export async function listCatalog(opts: { q?: string | null; limit?: number; all?: boolean } = {}): Promise<AtlasDoc[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const conds = [];
  if (!opts.all) conds.push(workingPredicate());
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conds.push(or(sql`${catalog.domain} ILIKE ${like}`, sql`${catalog.title} ILIKE ${like}`, sql`${catalog.origin} ILIKE ${like}`));
  }
  const rows = await db()
    .select(listingColumns)
    .from(catalog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(catalog.confidence), desc(catalog.toolCount), catalog.title)
    .limit(limit);
  return rows.map(rowToDoc);
}

/** Find ANY stored entry for a domain (no working filter) - the extension's "do we have tools here?" path. */
export async function findCatalogByDomain(domain: string): Promise<AtlasDoc | null> {
  const rows = await db()
    .select(listingColumns)
    .from(catalog)
    .where(sql`${catalog.domain} = ${domain}`)
    .limit(1);
  return rows[0] ? rowToDoc(rows[0]) : null;
}

/** Find one working catalog entry by domain OR serverId (no artifact). */
export async function findCatalogEntry(idOrDomain: string): Promise<AtlasDoc | null> {
  const rows = await db()
    .select(listingColumns)
    .from(catalog)
    .where(and(matchKey(idOrDomain), workingPredicate()))
    .limit(1);
  return rows[0] ? rowToDoc(rows[0]) : null;
}

/** Find a working entry's stored artifact (the heavy blob) by domain OR serverId - the download path only. */
export async function findCatalogArtifact(
  idOrDomain: string,
): Promise<{ artifact: unknown; domain: string; serverId: string | null; version: number } | null> {
  const rows = await db()
    .select({ artifact: catalog.artifact, domain: catalog.domain, serverId: catalog.serverId, version: catalog.version })
    .from(catalog)
    .where(and(matchKey(idOrDomain), workingPredicate()))
    .limit(1);
  return rows[0] ?? null;
}

function matchKey(idOrDomain: string) {
  // serverId is uuid; cast to text so a domain value never errors the comparison.
  return or(sql`${catalog.domain} = ${idOrDomain}`, sql`${catalog.serverId}::text = ${idOrDomain}`);
}

/**
 * Upsert a catalog entry by domain with MERGE ($set) semantics: only the columns present in `body` are
 * written, so a tools-only write (e.g. the extension) NEVER nulls a previously-stored `artifact`. New rows
 * get safe defaults for the NOT NULL columns (origin/title fall back to the domain).
 */
export async function upsertCatalog(domain: string, body: Record<string, unknown>): Promise<void> {
  const provided = bodyToColumns(body);
  const insert = {
    domain,
    origin: (provided.origin as string) || `https://${domain}`,
    title: (provided.title as string) || domain,
    ...provided,
  };
  await db()
    .insert(catalog)
    .values(insert as typeof catalog.$inferInsert)
    .onConflictDoUpdate({ target: catalog.domain, set: { ...provided, updatedAt: new Date() } });
}
