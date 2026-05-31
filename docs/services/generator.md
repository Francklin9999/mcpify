# Service — Generator (Node.js): Inference + Codegen + Self-Healer

## Purpose
The brain. Consumes a `CaptureBundle`, uses Claude to **infer tool definitions**, **generates a runnable
MCP server** with `@modelcontextprotocol/sdk`, and **self-heals** broken tools when the monitor enqueues a
job. Three internal modules, one service.

> ⚠️ The **self-healer lives here (Node + Claude)**, not in the Go monitor. The monitor only detects and
> enqueues; this service does all Claude/codegen work. (Corrects the source diagram.)

## Inputs / Outputs
| Module | Input | Output |
|--------|-------|--------|
| Inference | `CaptureBundle` (`01 §1`) | `InferenceResult` / `ToolDefinition[]` (`01 §2`) |
| Codegen | `ToolDefinition[]` | `GeneratedServerArtifact` (`01 §3`) |
| Self-healer | `SelfHealJob` / `RegenerateJob` (`01 §4`) | new `ServerVersion` (`01 §5`, `02`) |

## Dependencies
- **`@modelcontextprotocol/sdk`** — official MCP server SDK (emit `server.ts` against it).
- **`@anthropic-ai/sdk`** — Claude API, structured JSON tool output for inference.
- **`zod`** — validate every `ToolDefinition.inputSchema` before codegen; reject invalid.
- **BullMQ** — consume jobs from Redis (`mcp-jobs`). Producer is web (`generate`) and monitor (`self_heal`,`regenerate`).
- **scraper** — calls it (sync HTTP v1) to get a `CaptureBundle` for `generate`/`regenerate`.
- **Drizzle/Postgres + R2** — persist artifact + rows (`02`).

## Module 1 — Inference
1. Receive `CaptureBundle`. The `NetworkCapture[]` is the **highest-signal** input — prefer
   `execution.kind:'http'` (call the discovered API) over `'browser'` when a clean API call exists.
2. Prompt Claude with DOM + network captures → structured `ToolDefinition[]`: `name`, `description`,
   `inputSchema`, `execution` (http via `NetworkCapture` + `ParamMapping`, or browser `steps`), `confidence`.
3. **zod-validate** each tool; drop/repair invalid ones. Compute aggregate `confidence` (`01 §5` rules).
4. Use prompt caching on the system/tooling prompt (Claude API skill) since bundles share a large fixed preamble.

## Module 2 — Codegen
1. `ToolDefinition[]` → `server.ts` using `@modelcontextprotocol/sdk` (one MCP tool per definition).
2. Emit `claude_desktop_config.json` snippet + README. Bundle as `GeneratedServerArtifact` (`01 §3`).
3. Upload artifact zip → R2 `artifacts/{serverId}/{version}.zip` (`02`); write `servers`,
   `server_versions`, `tools` rows; set `servers.status='active'`, `last_parsed_at=now`.
4. Cache job result → `job:{jobId}` (Redis) for `GET /api/jobs/:id`.

## Module 3 — Self-healer (the differentiator)
- **`self_heal`:** given `ToolFailure` (`01 §4`), re-snapshot **only the failing tool's page** (via
  scraper or light path), ask Claude to rewrite **just that one** selector/step/`ParamMapping`. Bump
  version, `created_by:'self_heal'`. Cheaper than full regen. Scrapling's adaptive tracking already heals
  many selector misses upstream — self-heal handles the rest.
- **`regenerate`:** full Flow A (inference+codegen) for the URL on `large_drift`. Bump version.
- Both recompute `confidence` and restore `servers.status='active'`.

## Job idempotency
Idempotent on `(serverId, version)` — re-running a job yields the same or a higher version, never a dup
(`03`). Use a monotonic version counter per server.

## Data touchpoints
- Reads: `mcp-jobs` (Redis), scraper response, existing `servers`/`tools` rows (for heal).
- Writes: `servers`, `server_versions`, `tools` (Postgres); artifact (R2); `job:{jobId}` (Redis).

## How to test in isolation
- **Inference:** feed `fixtures/capture-bundles/*.json`; mock the Anthropic SDK with canned structured
  responses; assert zod validation drops malformed tools and aggregate confidence is computed.
- **Codegen:** feed fixture `ToolDefinition[]`; assert emitted `server.ts` compiles and registers N tools;
  snapshot the config snippet. No live Claude, no live scraper, no live DB (use a test Postgres + in-mem R2).
- **Self-healer:** feed a `SelfHealJob` + a fixture "post-change" bundle; assert only the failing tool's
  definition changes and version bumps.

## Acceptance criteria
- Fixture bundle ⇒ ≥1 valid, zod-passing `ToolDefinition`; invalid ones dropped, not crashed.
- Emitted `server.ts` builds and exposes the tools through `@modelcontextprotocol/sdk`.
- A `self_heal` job changes exactly the failing tool and increments the version.
- Artifact lands in R2 and rows land in Postgres matching `01 §3/§5`.

## Status (implemented)
- All three modules built and tested in isolation (`services/generator/`, 14 tests):
  `inference` (validation-gate, mockable port), `codegen` (verified MCP SDK API), `self-heal` (the
  differentiator), and the `generate` orchestrator (ports).
- **Codegen** is proven two ways: a type-check against the real SDK **and** an in-memory client round-trip
  (listTools + callTool executing http path/query/header/body). The emitted artifact is a standalone
  installable project (package.json + tsconfig) — clean-room verified to `npm install && build` and
  complete a real MCP `initialize`/`tools/list` handshake.
- **Self-heal** enforces the acceptance criterion: a `self_heal` job changes **exactly** the failing tool
  and increments the version; heal failure (invalid/renamed/non-JSON) ⇒ no new version, status `degraded`.
- **Regenerate** handler re-parses an existing server wholesale and bumps its version (`createdBy:auto`).
- Both self-heal & regenerate go through a shared `VersionPersistence.writeVersion` that **makes the new
  version live** — inserts the version AND repoints `servers.current_version`/`status`/`confidence`
  (without that step a heal silently keeps serving the broken version).
- **Verified:** MCP SDK API is `McpServer.registerTool(name, {description, inputSchema}, cb)` +
  `StdioServerTransport`; requires zod **`^3.25 || ^4`**; the generated server binds `registerTool` to a
  simplified signature to avoid a zod-4 TS2589 deep-instantiation (runtime identical). See the package README.
## Integration worker (implemented + verified against real infra)
- `worker.ts` (BullMQ consumer on `mcp-jobs`) + adapters: `HttpScraper` (calls the Python scraper, validates
  the wire response through `CaptureBundle`), `PostgresStore` (transactional multi-table writes over `@mcp/db`),
  `FsArtifactStore` (R2-shaped; filesystem for dev).
- **Verified end-to-end against real Docker Redis + Postgres** (`test/integration/`, 5 tests, run via
  `run.sh`): generate writes atomic rows + points the server at v1; **idempotent** under at-least-once
  delivery via a `processed_jobs` key in the same transaction (generate AND self_heal retries don't
  duplicate); self_heal repoints `current_version` and changes exactly the failing tool; full BullMQ
  enqueue→worker→row round-trip.
- **Node↔Python seam verified at runtime** (`scraper-seam.sh`): the real `HttpScraper` calls the real
  uvicorn scraper and Node's `CaptureBundle.parse()` accepts the response.
- **Contract fix found here:** BullMQ rejects `:` in queue names → `QUEUE_NAME` is `mcp-jobs` (was `mcp:jobs`).

## Generation guarantees (post-real-world fixes)
- **`generate` is upsert-by-URL.** `servers.url` is unique; generating a URL that already exists reuses
  that server row and bumps its version (rather than minting an orphan serverId whose `server_versions`
  FK insert then crashes). Verified by the worker integration "same url twice" test.
- **Content-tool floor (source-agnostic).** `inferTools` guarantees ≥1 tool: if an inference source
  (heuristic, OpenAI, Claude) returns zero usable tools, it synthesizes a `fetch_page_content` tool from
  the URL. So generation never produces a zero-tool "broken" server — `broken`/`degraded` is now a runtime
  state the monitor sets via health checks, not a generation outcome. A content-only server reads as low
  confidence (~0.5).
- **Tool names deduped** in the gate (a list page firing the same templated endpoint repeatedly no longer
  crashes `registerTool`).
- **HTML responses → readable text.** The generated server's `callHttp` detects `text/html` responses and
  returns extracted, tag-stripped text (scripts/styles removed, entities decoded, capped at 40k chars)
  instead of raw markup. So `fetch_page_content` on a docs/content page hands the LLM usable text, not an
  800KB HTML blob. JSON/other responses pass through unchanged. (Verified against live docs.python.org:
  818KB HTML → 40KB clean text.)

## Heuristic tool sources (keyless, no-LLM path)
The heuristic builds genuinely useful tools from a bundle, not just the content fallback:
- **HTML analysis** — before inference, `html-analysis.ts` normalizes raw HTML into page facts the LLM and
  heuristic can both use: title/meta/canonical, forms/fields, buttons, links, JSON-LD `@type`s, likely page
  kinds (`searchable`, `product_listing`, `product_detail`, `commerce`), and repeated detail-link patterns.
  This gives the LLM structured context instead of a giant undifferentiated HTML blob.
- **content tool** — `fetch_page_content`, returns readable text (floor; every site).
- **form tools** — parses `<form>`s from the DOM. A search form becomes a `search` tool; other forms
  become `<method>_<action>` tools. GET fields → query params, POST fields → body params. **Login forms
  (any `password` field) are skipped** (a tool needing creds violates the session/legal stance); hidden/
  CSRF/submit inputs are excluded (the model can't supply them). Parsing is wrapped try/catch → never
  crashes the worker. *Verified live: mining en.wikipedia.org yields a `search` tool that, called with
  `search=asyncio`, returns 66KB of real results.*
- **detail-link tools** — repeated/public product or item links like `/products/red-shoe` and
  `/products/blue-shoe` become a generic `get_product_page({ id })` tool, even without a domain recipe.
- **network tools** — one per observed XHR/fetch. Path params (`{id}`) are **required**; query params are
  parsed from `rawUrl` and added as **optional** (so callers never have to supply tracking junk); a
  tracking denylist drops `utm_*`/`pd_rd_*`/`fbclid`/etc.
- **site recipes** — deterministic domain-aware tools are merged before the validation gate for hard sites
  where capture/model inference may be weak. Amazon currently gets `search_products` and
  `get_product_page` from `services/generator/src/site-recipes.ts`; add more recipes there for stable
  public actions on important domains.
- **Known limit:** the scraper records response bodies but **not request bodies**, so POST *network* tools
  can't recover body params (POST *form* tools can, from field names). Capturing request bodies in the
  scraper is the follow-up that would unlock POST-API tools.
- **Non-http(s) form actions** (`javascript:`/`mailto:`/`tel:`, common on JS-driven forms) are skipped — no
  junk tool that fetch()es to nothing.

## Robustness ("any site") guarantee
The generate→codegen→compile→run path never crashes and always yields a compilable, runnable server with
≥1 tool, regardless of how malformed the captured data is. This holds because: every candidate tool passes
the `ToolDefinition` zod gate (invalid dropped), names are deduped, the content tool is the floor, and
**all** strings emitted into `server.ts` are `JSON.stringify`d (no code-injection from hostile field/param
names). Verified two ways:
- **Adversarial fuzz** (21 cases): hostile form field names (quotes, `${}`, `__proto__`, newlines, unicode),
  100-field forms, weird HTTP methods, 5×`{id}` paths, 200-call captures, name collisions, odd URLs, empty
  HTML — 0 crashes, 0 compile failures, 0 dup names.
- **14 diverse live sites** (Wikipedia, HN, GitHub, StackOverflow, PyPI, Reddit, BBC, python.org, httpbin,
  duckduckgo, toscrape, example.com): all captured, generated, compiled, and ran; most yielded a real
  `search`/form tool, content-only sites fell back to `fetch_page_content`.

## Still unverified / deferred
- **Live-Claude leg**: inference/heal are mocked in tests (can't burn live tokens) — the real
  `ClaudeInferenceClient`/`ClaudeHealClient` compile but aren't exercised end-to-end.
- Heal/regen **failure-persistence + escalation** (`03` Flow B: degraded → regenerate → broken).
- Prod **R2** adapter (interface done; only the FS impl is built).

## Open questions (verify before coding)
- Anthropic structured-output: we use plain JSON + contract-zod validation (open `inputSchema` can't satisfy
  structured-output `additionalProperties:false`). Revisit if a stricter wire format is wanted.
- Self-heal re-snapshot: reuse scraper vs. dedicated light path (`03` open Q).
