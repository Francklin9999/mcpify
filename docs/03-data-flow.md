# 03 - Data Flow (End-to-End)

What actually happens, step by step. Each arrow crosses a contract from `01`. This doc is the
integration test script for Phase 2.

## Flow A - User submits a URL (generation)

```
User (web app)
  |  POST /api/generate { url, legalMode }                         (01 S7)
  v
web API -- enqueue GenerateJob -->  Redis/BullMQ  (mcp-jobs)       (01 S4)
  |  returns { jobId }
  v
generator worker consumes GenerateJob
  |  1. legal gate: check legalMode (04). safe -> robots.txt must allow.
  |  2. request a CaptureBundle from scraper
  v
scraper  (Python, 3 tiers)
  |  tier 1 fast HTTP -> tier 2 Playwright stealth -> tier 3 Camoufox
  |  produces CaptureBundle  (01 S1)  -- DOM + NetworkCapture[]
  v
generator: inference (Claude API)
  |  CaptureBundle -> InferenceResult { tools[], confidence }       (01 S2)
  |  zod-validate every ToolDefinition; drop invalid
  v
generator: codegen (@modelcontextprotocol/sdk)
  |  ToolDefinition[] -> GeneratedServerArtifact (server.ts + config) (01 S3)
  |  upload artifact -> R2 ; write servers/server_versions/tools -> Postgres (02)
  |  cache result -> job:{jobId} (Redis)
  v
web: GET /api/jobs/:jobId -> { status, result?, error? }   status  in  queued|running|done|failed
     (web polls; on 'done' -> result is the artifact)
  |
  v
User downloads server code + pastes claude_desktop_config.json snippet. Runs LOCALLY on user machine.
```

**Key framing:** the generated MCP server runs on the **user's** machine. We never run scraped tools at
scale server-side. See `04`.

## Flow B - Keeping a server alive (monitor -> self-heal)

> Monitor polls the **source site/API** each server was generated from - never user-deployed instances
> (those run locally on user machines). `session`-mode authenticated tools are **unmonitorable
> server-side**; this flywheel covers **public tools only**.

```
monitor (Go, goroutines, never opens a browser)
  |  periodically for each active server:
  |   * Health check: HTTP HEAD / cheap tool call -> health_events (02)
  |   * Change detect: HTTP HEAD + DOM hash diff vs Redis dom:{serverId}
  v
  +- small diff  -> auto-patch confidence (update servers.confidence)        no job
  +- tool failed -> enqueue SelfHealJob { serverId, toolName, failure }      (01 S4)
  +- large diff  -> enqueue RegenerateJob { serverId, reason:'large_drift' } (01 S4)
        |
        v
generator consumes job:
   self_heal  -> re-snapshot just the failing tool's page; Claude rewrites that one
                selector/step; bump version (created_by:'self_heal').       (generator.md)
   regenerate -> full Flow A inference+codegen for the URL; bump version.
        |
        v
   new ServerVersion written; servers.status back to 'active'; confidence recomputed.
```

> Self-heal is **generator (Node+Claude)**, triggered by the **monitor (Go)** only via the queue. The Go
> service never calls Claude and never drives a browser. (Corrects the source diagram.)

## Flow C - Extension passive contribution (the flywheel)

```
User browses normally (side panel open)
  |  net-intercept (chrome.webRequest) silently records XHR/fetch
  v
extension builds a CaptureBundle { source:'extension' }            (01 S1, same shape as scraper)
  |  legal gate (04): session mode, user's own account, NEVER persist credentials/raw secrets
  v
POST /api/servers/:id/contribute { CaptureBundle }                 (01 S7)
  |  stored as contribution (pending) -> improves future inference / heals broken tools
  v
Community/auto pipeline can graduate auto_gen -> curated.
```

## Failure & idempotency notes
- Every job is idempotent on `(serverId, version)` - re-running produces the same or a higher version, never a dup.
- Scraper tier escalation is bounded; if tier 3 fails, generator records `status:'broken'` and surfaces low confidence.
- `jobId` status is the only thing web polls; web never talks to scraper/generator/monitor directly.

## Open questions
- Does generator call scraper synchronously (HTTP) or via its own sub-queue? Recommend sync HTTP with timeout for v1.
- Self-heal page re-snapshot: reuse scraper, or a lighter dedicated path? (latency vs. reuse).
