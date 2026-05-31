# @mcp/generator

Inference + codegen (and, next, self-healer). Spec: [`docs/services/generator.md`](../../docs/services/generator.md).

## Modules

| Module | Input -> Output | Notes |
|--------|----------------|-------|
| `inference` | `CaptureBundle` -> validated `ToolDefinition[]` | Claude call behind the `InferenceClient` port. The module is the **validation gate**: parse model JSON, drop tools failing the contract zod, never throw on garbage. |
| `anthropic-client` | real `InferenceClient` | `claude-opus-4-8`, adaptive thinking, prompt-cached system prompt. **Compiled but not unit-tested** (tests mock the port); caching/thinking are integration-time claims. |
| `codegen` | `ToolDefinition[]` -> `GeneratedServerArtifact` | Emits a **standalone installable project**: `server.ts` (MCP SDK) + `package.json` (pinned deps) + `tsconfig.json` + config snippet + README. Deterministic. `http` execution (path/query/header/body) fully implemented; `browser` tools register but return an isError stub (v1 public-only). |
| `generate` | `GenerateRequest` -> outcome | Orchestrates scraper->inference->codegen->persist via **ports** (real BullMQ/scraper/Postgres/R2 wiring is the next unit). Zero usable tools => server `broken`, not a healthy empty server. |
| `self-heal` | `SelfHealJob` + current server -> outcome | The differentiator. Re-snapshots, rewrites **only** the failing tool (Claude behind `HealClient`), bumps the version. Heal failure (invalid/renamed/non-JSON) => no new version, status `degraded`. |
| `regenerate` | `RegenerateJob` + current server -> outcome | Re-parses an **existing** server wholesale (large drift) and bumps **its** version (`createdBy:auto`). 0 tools => new version is `broken`. |
| `version-write` | shared port | `VersionWrite` + `VersionPersistence` for self-heal/regenerate. `writeVersion` MUST insert the version **and** repoint `servers.current_version`/`status`/`confidence`/`lastParsedAt` - without that, a new version never goes live. |

## Verified facts (don't rediscover these)

- **zod must be `^3.25 || ^4`** - the `@modelcontextprotocol/sdk` requires it; our earlier `3.23.8` pin was
  below range and the generated server's schemas didn't type-check against `registerTool`. The repo is on
  zod `^3.25`. (The Anthropic SDK pulls its own zod 4 nested; irrelevant to codegen.)
- **Generated server binds `registerTool` to a simplified signature.** The SDK's full generic
  deep-instantiates over zod 4's types (TS2589). The generated code does
  `server.registerTool.bind(server) as ... (name, {description, inputSchema}, cb) => void`. Runtime is
  identical; this only tames the static view. Proven by the two-gate codegen test below.

## How it's tested (in isolation, no network/DB)

- **inference**: mock `InferenceClient` with fixture JSON - asserts the gate drops invalid tools,
  computes confidence over survivors, and returns zero tools on all-invalid / non-JSON.
- **codegen - Gate A**: writes the generated `server.ts` and runs `tsc` against the **real** MCP SDK
  (catches a hallucinated SDK API).
- **codegen - Gate B**: imports the compiled server, connects an MCP `Client` over `InMemoryTransport`,
  asserts `listTools()` and that `callTool()` issues the HTTP request built from `paramMapping` (with
  `fetch` stubbed). Proves the server **acts**, not just compiles.
- **generate**: fake scraper + inference + in-memory persistence - asserts active vs. broken and that the
  written `RegistryEntry` satisfies the contract.

```bash
npm run test --workspace=@mcp/generator
```

**Clean-room verified** (manually, outside the monorepo): the emitted artifact `npm install && npm run build`
succeeds on the pinned ranges, and the standalone server completes a real MCP `initialize` + `tools/list`
handshake over stdio. This is the true "runs on the user's machine" bar that the in-repo compile can't see.

## Next unit (deferred)

- **Real wiring (integration, Phase 2):** a BullMQ worker consuming `mcp:jobs` that dispatches
  `generate`->`generate()`, `regenerate`->`regenerate()`, `self_heal`->`selfHeal()` (the worker resolves
  `serverId`->`CurrentServer` from `@mcp/db` for the latter two); a Postgres adapter implementing
  `GeneratePersistence` + `VersionPersistence` over `@mcp/db`; an R2 `saveArtifact` adapter; the scraper
  HTTP client. Needs Redis + Postgres - verify end-to-end against `03-data-flow.md`.
- **Carry into the worker unit (C):**
  - **Heal/regen failure persistence + escalation.** A failed `self_heal` currently writes nothing and
    returns `degraded`. The worker must record the failed attempt and decide escalation per `03` Flow B
    (degraded -> `regenerate`, repeated failure -> mark `broken`).
  - **Retry-safety.** `version = current.version + 1` is not idempotent under BullMQ at-least-once
    delivery - a retry would mint another version. The worker (or `writeVersion`) needs a conditional/
    dedup write keyed on the job, so one failure yields one version.
