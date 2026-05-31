import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

// Track which migrations have already run so re-invoking this script
// (run.sh calls it on every startup) is a no-op instead of replaying
// non-idempotent DDL like `CREATE TYPE`.
await sql`
  CREATE TABLE IF NOT EXISTS "__migrations" (
    "name" text PRIMARY KEY,
    "applied_at" timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Set(
  (await sql`SELECT "name" FROM "__migrations"`).map((r) => r.name),
);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`Skipping ${file} (already applied)`);
    continue;
  }

  const contents = readFileSync(join(migrationsDir, file), "utf8");
  // drizzle separates statements with this marker.
  const statements = contents
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Applying ${file}...`);
  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
    await tx`INSERT INTO "__migrations" ("name") VALUES (${file})`;
  });
  count++;
}

await sql.end();
console.log(`Migrations applied (${count} new).`);
