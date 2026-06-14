// Regression tests for the persistence hardening: (1) concurrent/same-URL generations reserve DISTINCT dirs
// (no silent overwrite), (2) a corrupt registry.json is backed up rather than silently destroyed.
// Run: node test/persistence.mjs
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "forge-persist-"));
process.env.URLMCP_HOME = HOME;
const { FsPersistence } = await import("../dist/src/persistence.js");

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };

// 1. Same-URL generations must reserve distinct dirs/versions (atomic mkdir lock), so files can't clobber.
try {
  const p = new FsPersistence();
  const a = await p.nextServer("https://dup.example.com");
  const b = await p.nextServer("https://dup.example.com");
  assert.notStrictEqual(a.version, b.version, "versions must differ");
  const da = p.dirFor(a.serverId);
  const db = p.dirFor(b.serverId);
  assert.ok(da && db && da !== db, "reserved dirs must differ");
  assert.ok(existsSync(da) && existsSync(db), "both dirs exist on disk");
  ok("same-URL generations reserve distinct dirs (no overwrite)");
} catch (e) { bad("distinct dirs", e.message); }

// 2. A corrupt registry.json is renamed to .corrupt-* and replaced, not silently overwritten/lost.
try {
  const reg = join(HOME, "registry.json");
  writeFileSync(reg, "{ this is : not valid json ]");
  const p = new FsPersistence();
  const entry = {
    serverId: "00000000-0000-4000-8000-000000000001",
    url: "https://corrupt.example.com",
    title: "Corrupt",
    tier: "auto_gen",
    confidence: 0.5,
    installCount: 0,
    lastParsedAt: new Date().toISOString(),
    status: "active",
    currentVersion: 1,
  };
  await p.writeRegistry(entry, [], join(HOME, "servers", "corrupt-example-com-v1"));
  const backups = readdirSync(HOME).filter((f) => f.startsWith("registry.json.corrupt-"));
  assert.strictEqual(backups.length, 1, "exactly one corrupt backup created");
  const rows = JSON.parse(readFileSync(reg, "utf8"));
  assert.ok(Array.isArray(rows) && rows.length === 1 && rows[0].url === "https://corrupt.example.com", "fresh registry holds the new row");
  ok("corrupt registry.json is backed up + replaced, not silently lost");
} catch (e) { bad("corrupt registry backup", e.message); }

if (failed) { console.error(`\n${failed} persistence check(s) FAILED`); process.exit(1); }
console.log("\nPASS: persistence reserves distinct dirs and preserves a corrupt registry via backup.");
