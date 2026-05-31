# Service - Monitor (Go): Health Check + Change Detection + Enqueue

## Purpose
Keep thousands of registered servers alive **cheaply and concurrently**. Polls health, detects page
drift, updates confidence, and **enqueues** regeneration/self-heal jobs. Uses goroutines; **never opens a
browser and never calls Claude** - that work belongs to the generator.

> (!) **The monitor targets the SOURCE website/API a server was generated from - never user-deployed
> server instances.** Generated servers run locally on thousands of user machines; a server-side Go
> service cannot and must not reach them. "Health check" = test-call the discovered public endpoints +
> DOM-hash the original source URL. **Scope boundary:** `session`-mode (authenticated) tools are
> **unmonitorable server-side** (no credentials, and the monitor must not have them) - the
> health-check/self-heal flywheel covers **public tools only**.

> (!) This service only **detects and enqueues**. All healing/codegen/Claude is in `services/generator`.
> (Corrects the source diagram, which visually groups self-heal with Go.)

## Inputs / Outputs
- **Input:** `servers` rows where `status='active'` (Postgres, `02`); Redis `dom:{serverId}` snapshots.
- **Output:** `health_events` rows; `servers.status`/`confidence` updates; **queue messages**
  `SelfHealJob` / `RegenerateJob` (`01 S4`). It is the **only producer of those two job kinds**.
- Mirrors only `01 S4` (queue) and `01 S5` (registry rows) as Go structs (`01 SCross-language`).

## Dependencies
- **Go stdlib `net/http`** + goroutine worker pool - concurrent cheap polling.
- **Redis (BullMQ-compatible enqueue)** - push jobs Node consumes. Verify BullMQ job format from Go
  (BullMQ is a Node lib; the Go side must write the exact Redis structures BullMQ expects - see Open Qs).
- **Postgres (Go driver, e.g. pgx)** - read `servers`, write `health_events`, update status/confidence.
- Fully decoupled from generator: communication is async via the queue only.

## Two detectors
### Health checker
- Per active server, on an interval: HTTP HEAD and/or a cheap representative tool call.
- Write `health_events` (pass/fail + `error_class` matching `ToolFailure.errorClass`, `01 S4`).
- On `fail` for a specific tool => enqueue `SelfHealJob { serverId, toolName, failure }`.
- Pass/fail nudges `servers.confidence` within [0,1] per `01 S5` confidence rules.

### Change detector
- HTTP HEAD + fetch-light to compute a DOM hash; diff against Redis `dom:{serverId}`.
- **Small diff** => auto-patch confidence, update stored hash, **no job**.
- **Large diff** => enqueue `RegenerateJob { serverId, reason:'large_drift' }`; set `status='regenerating'`.

## Scheduling
- Goroutine worker pool sized to host concurrency limits; respect per-host rate limits (Redis `rl:{host}`).
- Stagger polling so thousands of sites don't stampede. Backoff on repeated failures.

## Data touchpoints
- Reads: `servers` (active), Redis `dom:{serverId}`, `rl:{host}`.
- Writes: `health_events`, `servers.status`/`confidence`, Redis `dom:{serverId}`, enqueue to `mcp-jobs`.

## Implementation steps
1. Go structs for `01 S4` job payloads + `01 S5` rows.
2. pgx connection + query for active servers.
3. Worker pool + scheduler with per-host rate limiting and stagger.
4. Health checker -> `health_events` + confidence update + `SelfHealJob` enqueue.
5. Change detector -> DOM hash diff + small/large branch + `RegenerateJob` enqueue.
6. BullMQ-compatible enqueue (verify the on-wire Redis format).

## How to test in isolation
- Spin a local HTTP test server returning controllable status codes / changing HTML.
- Use a test Postgres + test Redis (testcontainers or docker-compose).
- Assert: failing tool => a `SelfHealJob` with correct shape lands in Redis; large DOM diff => `RegenerateJob`
  + `status='regenerating'`; pass/fail moves confidence in the right direction within bounds.
- **No generator needed** - assert on the enqueued message, not on healing.

## Acceptance criteria
- A simulated tool failure produces exactly one well-formed `SelfHealJob` (`01 S4`).
- A large DOM change produces a `RegenerateJob` and flips status to `regenerating`.
- Confidence updates stay within [0,1] and follow `01 S5`.
- Service never launches a browser and never imports an LLM client (enforced by a dependency check/lint).

## Open questions (verify before coding)
- **BullMQ wire format from Go:** BullMQ is Node-native; confirm the exact Redis key/stream structure a Go
  producer must write so Node workers pick jobs up. Alternative: a thin Node "enqueue" shim, or a
  language-neutral queue. Decide in Phase 1.
- DOM-hash algorithm + "small vs large diff" threshold - define and tune with real sites.
