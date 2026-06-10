import { eq, and } from "drizzle-orm";
import type { Database } from "@mcp/db";
import { servers, serverVersions, tools as toolsTable, processedJobs } from "@mcp/db";
import { RegistryEntry, ToolDefinition, type JobKind } from "@mcp/types";

import type { GeneratePersistence } from "../generate.js";
import type { VersionPersistence, VersionWrite } from "../version-write.js";
import type { CurrentServer } from "../self-heal.js";
import type { ArtifactStore } from "./artifact-store.js";

/**
 * Postgres persistence over @mcp/db. Every multi-table write (versions + tools + current-version pointer +
 * the processed_jobs idempotency marker) is one transaction, so a retry is a no-op and a partial failure
 * can't leave current_version pointing at half-written tools. loadCurrentServer is contract-validated.
 */
export class PostgresStore {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
  ) {}

  async isProcessed(jobId: string): Promise<boolean> {
    const rows = await this.db.select().from(processedJobs).where(eq(processedJobs.jobId, jobId)).limit(1);
    return rows.length > 0;
  }

  /** Load an existing server for self_heal / regenerate (RegenerateJob/SelfHealJob carry only serverId). */
  async loadCurrentServer(serverId: string): Promise<CurrentServer | null> {
    const [srv] = await this.db.select().from(servers).where(eq(servers.serverId, serverId)).limit(1);
    if (!srv || srv.currentVersion == null) return null;
    const rows = await this.db
      .select()
      .from(toolsTable)
      .where(and(eq(toolsTable.serverId, serverId), eq(toolsTable.version, srv.currentVersion)));
    // Fail-closed: jsonb is not validated by the DB - parse each row through the contract.
    const defs = rows.map((r) => ToolDefinition.parse(r.definition));
    return { url: srv.url, title: srv.title, version: srv.currentVersion, tools: defs };
  }

  /** GeneratePersistence for a `generate` job. Upsert-by-URL: generating a URL that already exists bumps
   *  its version on the SAME server row (rather than minting an orphan serverId whose version-row FK then
   *  fails). servers.url is unique, so this is the natural idempotency key. */
  forGenerate(jobId: string): GeneratePersistence {
    return {
      nextServer: async (url: string) => {
        const [existing] = await this.db.select().from(servers).where(eq(servers.url, url)).limit(1);
        if (existing) return { serverId: existing.serverId, version: (existing.currentVersion ?? 0) + 1 };
        return { serverId: crypto.randomUUID(), version: 1 };
      },
      saveArtifact: (artifact) => this.artifacts.save(artifact),
      writeRegistry: async (entry: RegistryEntry, defs: ToolDefinition[], artifactUrl: string) => {
        await this.db.transaction(async (tx) => {
          await tx.insert(processedJobs).values({ jobId, kind: "generate" }).onConflictDoNothing();
          // Upsert the server row so it ALWAYS exists before the version-row FK insert. On a known URL we
          // update the live fields (preserving tier + installCount); on a new URL we create it.
          await tx
            .insert(servers)
            .values({
              serverId: entry.serverId,
              url: entry.url,
              title: entry.title,
              tier: entry.tier,
              confidence: entry.confidence,
              installCount: entry.installCount,
              status: entry.status,
              currentVersion: entry.currentVersion,
              lastParsedAt: new Date(entry.lastParsedAt),
            })
            .onConflictDoUpdate({
              target: servers.url,
              set: {
                title: entry.title,
                confidence: entry.confidence,
                status: entry.status,
                currentVersion: entry.currentVersion,
                lastParsedAt: new Date(entry.lastParsedAt),
              },
            });
          await insertVersionAndTools(tx, entry.serverId, entry.currentVersion, "auto", defs, artifactUrl);
        });
      },
    };
  }

  /** VersionPersistence for self_heal / regenerate (bumps an EXISTING server). */
  forVersion(jobId: string, kind: JobKind): VersionPersistence {
    return {
      saveArtifact: (artifact) => this.artifacts.save(artifact),
      writeVersion: async (w: VersionWrite) => {
        await this.db.transaction(async (tx) => {
          await tx.insert(processedJobs).values({ jobId, kind }).onConflictDoNothing();
          await insertVersionAndTools(tx, w.serverId, w.version, w.createdBy, w.tools, w.artifactUrl);
          // Repoint the server at the new version - this is what makes it LIVE (02 / version-write).
          await tx
            .update(servers)
            .set({
              currentVersion: w.version,
              status: w.status,
              confidence: w.confidence,
              lastParsedAt: new Date(w.lastParsedAt),
            })
            .where(eq(servers.serverId, w.serverId));
        });
      },
    };
  }
}

async function insertVersionAndTools(
  tx: any,
  serverId: string,
  version: number,
  createdBy: string,
  defs: ToolDefinition[],
  artifactUrl = "",
): Promise<void> {
  await tx
    .insert(serverVersions)
    .values({ serverId, version, artifactUrl: artifactUrl || `pending://${serverId}/${version}`, toolCount: defs.length, createdBy })
    .onConflictDoNothing();
  if (defs.length > 0) {
    await tx
      .insert(toolsTable)
      .values(
        defs.map((d) => ({
          serverId,
          version,
          name: d.name,
          confidence: d.confidence,
          executionKind: d.execution.kind,
          definition: d,
        })),
      )
      .onConflictDoNothing();
  }
}
