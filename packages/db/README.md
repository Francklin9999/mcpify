# @mcp/db

Postgres schema (Drizzle) + migrations — the registry of record. Spec: [`docs/02-data-model.md`](../../docs/02-data-model.md).
Owns **Postgres only**; Redis/R2 key layout lives in `@mcp/types` (`keys.ts`).

## Use

```ts
import { createDb, servers, serverVersions } from "@mcp/db";

const db = createDb(process.env.DATABASE_URL!);
const active = await db.select().from(servers).where(/* ... */);
```

## Tables (5)

`servers` · `server_versions` · `tools` · `health_events` · `contributions`. See `02` for columns.

Key shape decisions (verified against real Postgres):
- `server_versions` PK is **composite** `(server_id, version)`; `tools` FKs to it compositely and PKs on
  `(server_id, version, name)`.
- `servers.current_version` is a **plain nullable pointer, not a FK** (composite-PK + circular-insert
  reasons). Insert order: server → version → set pointer → tools.
- `tools.definition` jsonb is **compile-time typed only** — the generator MUST `ToolDefinition.parse()`
  before insert (Drizzle does not validate writes).
- Enum values are parity-tested against `@mcp/types` so they can't drift from the contract.

## Scripts

```bash
npm run build    --workspace=@mcp/db   # tsc
npm run test     --workspace=@mcp/db   # enum parity + shape (no DB needed)
npm run generate --workspace=@mcp/db   # drizzle-kit → migrations/*.sql (offline)
# Apply to a real DB (proves the schema lands):
docker compose -f infra/docker-compose.yml up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mcp npm run apply --workspace=@mcp/db
```

Migrations are committed under `migrations/`. Regenerate after any `schema.ts` change.
