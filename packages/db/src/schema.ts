import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import type { ToolDefinition, GeneratedServerArtifact } from "@mcp/types";

/**
 * Postgres schema for the registry of record (`02-data-model.md`).
 * Enum VALUES are hardcoded here but parity-tested against `@mcp/types` (see test/schema.test.ts) so they
 * cannot drift from the contract (consistent with the v1 hand-maintained-mirror + drift-test approach).
 */

// Enums
export const serverTierEnum = pgEnum("server_tier", ["curated", "auto_gen"]);
export const serverStatusEnum = pgEnum("server_status", [
  "active",
  "degraded",
  "broken",
  "regenerating",
]);
export const executionKindEnum = pgEnum("execution_kind", ["http", "browser"]);
export const healthResultEnum = pgEnum("health_result", ["pass", "fail"]);
export const contributionStatusEnum = pgEnum("contribution_status", [
  "pending",
  "accepted",
  "rejected",
]);

// servers (= RegistryEntry)
export const servers = pgTable("servers", {
  serverId: uuid("server_id").primaryKey().defaultRandom(),
  url: text("url").notNull().unique(),
  title: text("title").notNull(),
  tier: serverTierEnum("tier").notNull(),
  confidence: real("confidence").notNull(),
  installCount: integer("install_count").notNull().default(0),
  status: serverStatusEnum("status").notNull(),
  // Plain nullable pointer to the live version - NOT a FK: server_versions' PK is composite
  // (server_id, version), so `version` alone isn't referenceable, and an FK here would create a
  // circular insert dependency. The generator maintains this after inserting the version row. (advisor #1)
  currentVersion: integer("current_version"),
  lastParsedAt: timestamp("last_parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// server_versions (= ServerVersion)
export const serverVersions = pgTable(
  "server_versions",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.serverId, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    artifactUrl: text("artifact_url").notNull(),
    toolCount: integer("tool_count").notNull(),
    createdBy: text("created_by").notNull(), // 'auto' | 'self_heal' | 'community' | userId
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.version] }),
  }),
);

// tools
export const tools = pgTable(
  "tools",
  {
    serverId: uuid("server_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    confidence: real("confidence").notNull(),
    executionKind: executionKindEnum("execution_kind").notNull(),
    // Compile-time typed only. Drizzle does NOT validate writes - the generator MUST
    // `ToolDefinition.parse()` before insert (fail-closed posture, like NetworkCapture). (advisor #4)
    definition: jsonb("definition").$type<ToolDefinition>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.version, t.name] }),
    versionFk: foreignKey({
      columns: [t.serverId, t.version],
      foreignColumns: [serverVersions.serverId, serverVersions.version],
    }).onDelete("cascade"),
  }),
);

// health_events (monitor writes, append-only)
export const healthEvents = pgTable("health_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: uuid("server_id")
    .notNull()
    .references(() => servers.serverId, { onDelete: "cascade" }),
  toolName: text("tool_name"), // null = whole-server check
  result: healthResultEnum("result").notNull(),
  errorClass: text("error_class"), // matches ToolFailure.errorClass (01 S4); text per 02
  domHash: text("dom_hash"),
  contentLength: integer("content_length"), // size metric for the monitor's small-vs-large drift call
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

// contributions (extension passive captures / community)
export const contributions = pgTable("contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").references(() => servers.serverId, { onDelete: "set null" }), // null = new site
  bundleRef: text("bundle_ref").notNull(), // R2 key, only when legalMode permits storage (04)
  contributedBy: text("contributed_by").notNull(),
  status: contributionStatusEnum("status").notNull().default("pending"),
});

// processed_jobs (idempotency keys for at-least-once BullMQ delivery)
// A job's id is inserted in the SAME transaction as its effects. A retry of an already-processed job
// conflicts here and is skipped - so e.g. self_heal's version+1 mints exactly one version per job.
export const processedJobs = pgTable("processed_jobs", {
  jobId: text("job_id").primaryKey(),
  kind: text("kind").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// catalog: the browsable directory of pre-generated MCP servers, keyed by domain (formerly MongoDB Atlas).
// DELIBERATELY separate from `servers`: catalog entries are a discovery directory, NOT operational servers,
// so the monitor (which polls `servers WHERE status='active'`) must never health-check or "heal" them.
// `tools` is read for listings; the full runnable `artifact` is selected only on the download path.
export const catalog = pgTable("catalog", {
  domain: text("domain").primaryKey(),
  serverId: uuid("server_id"),
  origin: text("origin").notNull(),
  title: text("title").notNull(),
  tier: text("tier").notNull().default("auto_gen"),
  confidence: real("confidence").notNull().default(0),
  installCount: integer("install_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  toolCount: integer("tool_count").notNull().default(0),
  localTestPassed: boolean("local_test_passed").notNull().default(false),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  tools: jsonb("tools").$type<ToolDefinition[]>().notNull().default([]),
  artifact: jsonb("artifact").$type<GeneratedServerArtifact>(),
  seededBy: text("seeded_by"), // tags rows written by a seed run, so a later run can retire stale ones
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  servers,
  serverVersions,
  tools,
  healthEvents,
  contributions,
  processedJobs,
  catalog,
};
