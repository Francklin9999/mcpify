/**
 * @mcp/db - Postgres schema + client factory. See docs/02-data-model.md.
 * Owns Postgres only; Redis/R2 key layout lives in `@mcp/types` (keys.ts).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export * from "./schema.js";

export type Database = ReturnType<typeof createDb>;

/** Create a Drizzle client bound to the full schema. Caller owns the connection lifecycle. */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}
