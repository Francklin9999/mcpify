import { test } from "node:test";
import assert from "node:assert/strict";

import { getTableConfig } from "drizzle-orm/pg-core";
import { ServerTier, ServerStatus, EXECUTION_KINDS } from "@mcp/types";
import {
  schema,
  serverTierEnum,
  serverStatusEnum,
  executionKindEnum,
  servers,
  serverVersions,
  tools,
  healthEvents,
  contributions,
} from "../src/index.js";

// Enum parity: DB enums must equal the @mcp/types contract value-spaces (drift guard)
test("server_tier enum matches ServerTier contract", () => {
  assert.deepEqual([...serverTierEnum.enumValues], [...ServerTier.options]);
});

test("server_status enum matches ServerStatus contract", () => {
  assert.deepEqual([...serverStatusEnum.enumValues], [...ServerStatus.options]);
});

test("execution_kind enum matches EXECUTION_KINDS contract", () => {
  assert.deepEqual([...executionKindEnum.enumValues], [...EXECUTION_KINDS]);
});

// Shape sanity
test("schema exports the expected tables", () => {
  assert.deepEqual(Object.keys(schema).sort(), [
    "contributions",
    "healthEvents",
    "processedJobs",
    "serverVersions",
    "servers",
    "tools",
  ]);
});

// Structural guards: codify the three hand-verified key decisions (offline)
test("servers has NO foreign keys (current_version is a plain pointer, not a FK)", () => {
  // The highest-reasoning-cost decision (advisor #1): an FK here is impossible (version not unique) and
  // would create a circular insert dependency. This fails loudly if someone re-adds it.
  assert.equal(getTableConfig(servers).foreignKeys.length, 0);
  assert.equal(servers.currentVersion.notNull, false);
});

test("server_versions has the composite PK (server_id, version)", () => {
  const pks = getTableConfig(serverVersions).primaryKeys;
  assert.equal(pks.length, 1);
  assert.deepEqual(
    pks[0]!.columns.map((c) => c.name),
    ["server_id", "version"],
  );
});

test("tools has a composite FK -> server_versions and a composite PK", () => {
  const cfg = getTableConfig(tools);
  assert.equal(cfg.foreignKeys.length, 1);
  assert.deepEqual(
    cfg.foreignKeys[0]!.reference().columns.map((c) => c.name),
    ["server_id", "version"],
  );
  assert.deepEqual(
    cfg.primaryKeys[0]!.columns.map((c) => c.name),
    ["server_id", "version", "name"],
  );
});

test("tables are wired (referential columns present)", () => {
  assert.ok(serverVersions.serverId);
  assert.ok(tools.serverId && tools.version && tools.name);
  assert.ok(healthEvents.serverId);
  assert.ok(contributions.bundleRef);
});
