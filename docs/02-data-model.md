# 02 — Data Model (Postgres / Redis / R2)

Storage layer. Built in Phase 0 right after contracts, before any service. Lives in `packages/db`
(Drizzle schema + migrations). All row shapes mirror the logical contracts in `01-contracts.md §5`.

## Postgres — registry of record

Tables (Drizzle). DDL intent below; implementer writes migrations.

### `servers` (= RegistryEntry)
| col | type | notes |
|-----|------|-------|
| server_id | uuid PK | |
| url | text unique | canonical |
| title | text | |
| tier | enum('curated','auto_gen') | curated hand-verified |
| confidence | real | 0..1, see `01 §5` confidence rules |
| install_count | int default 0 | |
| status | enum('active','degraded','broken','regenerating') | monitor updates |
| current_version | int null | **Plain nullable pointer, NOT a FK** — `server_versions` PK is composite `(server_id, version)`, so `version` alone isn't referenceable, and an FK would create a circular insert dependency. Generator maintains it (insert server → insert version → set pointer). |
| last_parsed_at | timestamptz | |
| created_at | timestamptz | |

### `server_versions` (= ServerVersion)
| col | type | notes |
|-----|------|-------|
| server_id | uuid FK | |
| version | int | monotonic per server |
| artifact_url | text | R2 key |
| tool_count | int | |
| created_by | text | 'auto'|'self_heal'|'community'|userId |
| created_at | timestamptz | |
| PRIMARY KEY | (server_id, version) | |

### `tools`
| col | type | notes |
|-----|------|-------|
| server_id | uuid FK | |
| version | int | |
| name | text | snake_case |
| confidence | real | per-tool |
| execution_kind | enum('http','browser') | |
| definition | jsonb | the `ToolDefinition` (01 §2). jsonb `$type<>` is compile-time only — the generator MUST `ToolDefinition.parse()` before insert (fail-closed, like `NetworkCapture`). |

PK `(server_id, name, version)`; composite FK `(server_id, version)` → `server_versions`.

### `health_events` (monitor writes, append-only)
| col | type | notes |
|-----|------|-------|
| id | bigserial PK | |
| server_id | uuid FK | |
| tool_name | text null | null = whole-server check |
| result | enum('pass','fail') | |
| error_class | text null | matches `ToolFailure.errorClass` (01 §4) |
| dom_hash | text null | for change detection |
| observed_at | timestamptz | |

### `contributions` (extension passive captures / community PRs)
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| server_id | uuid FK null | null if new site |
| bundle_ref | text | R2 key to a stored `CaptureBundle` (only if legalMode permits — see 04) |
| contributed_by | text | |
| status | enum('pending','accepted','rejected') | |

**Writers/readers:**
- `generator` writes `servers`, `server_versions`, `tools`.
- `monitor` writes `health_events`, updates `servers.status` + `servers.confidence`.
- `web` reads all; writes `install_count`, `contributions`.

## Redis — cache + queue + rate limiting

| Use | Key pattern | TTL |
|-----|-------------|-----|
| BullMQ job queue | `bull:mcp-jobs:*` | managed by BullMQ |
| DOM snapshot cache | `dom:{serverId}` → latest domHash + small snapshot | hours |
| Rate limit (per host) | `rl:{host}` | sliding window |
| Job status cache (for `GET /api/jobs/:id`) | `job:{jobId}` | minutes |

## R2 (object storage) — code artifacts & large blobs

| Object | Key | Producer |
|--------|-----|----------|
| Generated server artifact (zip of `files`) | `artifacts/{serverId}/{version}.zip` | generator |
| Stored capture bundle (only when legally allowed) | `bundles/{bundleId}.json` | scraper/extension via API |

> **Do not** store scraped page *content* at scale server-side (see `04`). R2 holds generated **code**
> and (conditionally) capture **bundles with sanitized schemas, not raw scraped data**.

## Open questions
- Partition/retention policy for `health_events` (append-only, high volume from thousands of sites).
- Whether `tools.definition` jsonb is duplicated into R2 artifact or is the artifact the source of truth.
