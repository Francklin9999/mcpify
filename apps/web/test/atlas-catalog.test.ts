import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { RegistryEntry } from "@mcp/types";
import {
  atlasDocToEntry,
  atlasDocToDetail,
  atlasDocToVersion,
  bodyToColumns,
  catalogKey,
  domainFromUrl,
  filterEntries,
  mergeRegistry,
} from "../lib/atlas-catalog.ts";

const seedDoc = {
  domain: "npmjs.com",
  origin: "https://www.npmjs.com",
  serverId: "11111111-1111-4111-8111-111111111111",
  title: "npm Package Intelligence",
  tier: "curated",
  status: "active",
  confidence: 0.98,
  version: 1,
  tools: [
    { name: "search_packages", description: "Search npm", confidence: 0.99 },
    { name: "get_package_metadata", description: "Fetch metadata", confidence: 0.97 },
  ],
  updatedAt: "2026-05-31T00:00:00.000Z",
};

test("catalogKey normalizes scheme, www, trailing slash, case", () => {
  assert.equal(catalogKey("https://www.NpmJS.com/"), "npmjs.com");
  assert.equal(catalogKey("http://npmjs.com"), "npmjs.com");
  assert.equal(catalogKey("npmjs.com"), "npmjs.com");
  assert.equal(catalogKey(undefined), "");
});

test("domainFromUrl extracts the bare host", () => {
  assert.equal(domainFromUrl("https://www.npmjs.com/package/react"), "npmjs.com");
  assert.equal(domainFromUrl("https://api.github.com/repos"), "api.github.com");
  assert.equal(domainFromUrl("not a url"), "not a url");
  assert.equal(domainFromUrl(""), "");
});

test("atlasDocToEntry maps a catalog doc to a RegistryEntry", () => {
  const e = atlasDocToEntry(seedDoc);
  assert.ok(e);
  assert.equal(e!.serverId, seedDoc.serverId);
  assert.equal(e!.url, "https://www.npmjs.com");
  assert.equal(e!.title, "npm Package Intelligence");
  assert.equal(e!.tier, "curated");
  assert.equal(e!.status, "active");
  assert.equal(e!.confidence, 0.98);
  assert.equal(e!.installCount, 0);
  assert.equal(e!.currentVersion, 1);
  assert.equal(e!.lastParsedAt, "2026-05-31T00:00:00.000Z");
});

test("atlasDocToEntry falls back: serverId=domain, origin from domain, tier=auto_gen, version>=1", () => {
  const e = atlasDocToEntry({ domain: "example.com", tools: [{ name: "a" }] });
  assert.ok(e);
  assert.equal(e!.serverId, "example.com");
  assert.equal(e!.url, "https://example.com");
  assert.equal(e!.tier, "auto_gen");
  assert.equal(e!.status, "active");
  assert.equal(e!.currentVersion, 1);
});

test("atlasDocToEntry rejects unknown tier/status by falling back to safe enum values", () => {
  const e = atlasDocToEntry({ domain: "x.com", tier: "bogus", status: "weird", tools: [] });
  assert.equal(e!.tier, "auto_gen");
  assert.equal(e!.status, "active");
});

test("atlasDocToEntry returns null without a usable identity", () => {
  assert.equal(atlasDocToEntry({}), null);
  assert.equal(atlasDocToEntry({ confidence: 0.5 }), null);
});

test("mergeRegistry: Postgres wins on url collision, Atlas-only entries append", () => {
  const pg: RegistryEntry[] = [
    { serverId: "pg1", url: "https://npmjs.com", title: "PG npm", tier: "auto_gen", status: "active", confidence: 0.5, installCount: 0, lastParsedAt: "2026-05-31T00:00:00.000Z", currentVersion: 2 },
  ];
  const atlas: RegistryEntry[] = [
    { serverId: "a1", url: "https://www.npmjs.com/", title: "Atlas npm", tier: "curated", status: "active", confidence: 0.98, installCount: 0, lastParsedAt: "2026-05-31T00:00:00.000Z", currentVersion: 1 },
    { serverId: "a2", url: "https://github.com", title: "Atlas gh", tier: "curated", status: "active", confidence: 0.97, installCount: 0, lastParsedAt: "2026-05-31T00:00:00.000Z", currentVersion: 1 },
  ];
  const merged = mergeRegistry(pg, atlas);
  assert.equal(merged.length, 2, "npm collapses to one (PG wins), github appends");
  assert.equal(merged[0]!.serverId, "pg1");
  assert.equal(merged[1]!.serverId, "a2");
});

test("filterEntries mirrors tier + q filtering", () => {
  const entries: RegistryEntry[] = [
    { serverId: "1", url: "https://npmjs.com", title: "npm", tier: "curated", status: "active", confidence: 1, installCount: 0, lastParsedAt: "2026-05-31T00:00:00.000Z", currentVersion: 1 },
    { serverId: "2", url: "https://github.com", title: "GitHub", tier: "auto_gen", status: "active", confidence: 1, installCount: 0, lastParsedAt: "2026-05-31T00:00:00.000Z", currentVersion: 1 },
  ];
  assert.equal(filterEntries(entries, { tier: "curated" }).length, 1);
  assert.equal(filterEntries(entries, { q: "git" }).length, 1);
  assert.equal(filterEntries(entries, { q: "GITHUB" })[0]!.serverId, "2");
  assert.equal(filterEntries(entries, {}).length, 2);
});

test("atlasDocToDetail produces tools + an /api/atlas/download link", () => {
  const d = atlasDocToDetail(seedDoc);
  assert.ok(d);
  assert.equal(d!.source, "atlas");
  assert.equal(d!.tools.length, 2);
  assert.equal(d!.tools[0]!.name, "search_packages");
  assert.match(d!.downloadUrl, /^\/api\/atlas\/download\?domain=npmjs\.com&version=1$/);
  assert.match(d!.downloadName, /^npmjs\.com-v1\.artifact\.json$/);
  assert.deepEqual(d!.versions, [1]);
});

test("atlasDocToDetail returns null for an identity-less doc", () => {
  assert.equal(atlasDocToDetail({}), null);
});

test("atlasDocToVersion builds a version row with atlas download metadata", () => {
  const v = atlasDocToVersion(seedDoc);
  assert.ok(v);
  assert.equal(v!.serverId, seedDoc.serverId);
  assert.equal(v!.version, 1);
  assert.equal(v!.toolCount, 2);
  assert.equal(v!.createdBy, "atlas-seed");
  assert.match(v!.artifactUrl, /^https:\/\/atlas\.local\/api\/atlas\/download\?serverId=/);
});

// bodyToColumns powers the catalog upsert's MERGE semantics. The critical invariant: a partial write must
// never carry an `artifact` key (so the DB UPDATE can't null a previously-stored artifact).
test("bodyToColumns: a tools-only write sets tools+toolCount but NOT artifact (never clobbers a stored artifact)", () => {
  const cols = bodyToColumns({ domain: "x.com", tools: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(cols.tools, [{ name: "a" }, { name: "b" }]);
  assert.equal(cols.toolCount, 2, "toolCount derived from tools length");
  assert.equal("artifact" in cols, false, "no artifact key on a tools-only write");
});

test("bodyToColumns: artifact is carried through ONLY when explicitly provided", () => {
  const withArtifact = bodyToColumns({ domain: "x.com", artifact: { serverId: "s", version: 1, files: [] } });
  assert.ok(withArtifact.artifact, "artifact present when provided");
  const without = bodyToColumns({ domain: "x.com", title: "X" });
  assert.equal("artifact" in without, false);
});

test("bodyToColumns: localTest.passed maps to localTestPassed; explicit toolCount wins", () => {
  assert.equal(bodyToColumns({ localTest: { passed: true } }).localTestPassed, true);
  assert.equal(bodyToColumns({ tools: [{ name: "a" }], toolCount: 5 }).toolCount, 5);
  // Unknown / wrong-typed fields are dropped, not forwarded.
  assert.equal("bogus" in bodyToColumns({ bogus: 1, confidence: "x" as unknown as number }), false);
  assert.equal("confidence" in bodyToColumns({ confidence: "x" as unknown as number }), false);
});
