# 01 - Contracts (KEYSTONE)

> Every cross-component data shape lives here, defined once. No other doc redefines a shape; they link
> here. Freeze these first (Phase 0) and every service can be built in isolation against fixtures.
>
> Canonical home: `packages/types` (TypeScript + zod). Python (`scraper`) and Go (`monitor`) mirror
> these - see SCross-language sync.

The shapes below are **structural intent**, not final field-by-field law. The implementer firms them up
in `packages/types`, but the *boundaries* (who produces, who consumes) are fixed and must not drift.

---

## 1. CaptureBundle - the big one

The single most important contract. It is the **input to generation**, and it is produced by **two
different sources** that the generator must not distinguish between:

- `services/scraper` (Scrapling, server-side fetch)
- `apps/extension` net-intercept (real user traffic, client-side)

Decoupling the generator from *where* a capture came from is the whole point of this shape.

```ts
interface CaptureBundle {
  bundleId: string;            // uuid
  source: 'scraper' | 'extension';
  url: string;                 // canonical page URL
  capturedAt: string;          // ISO-8601
  legalMode: LegalMode;        // see S6 and 04-legal-modes.md
  tier?: 1 | 2 | 3;            // scraper fetch tier used (absent for extension)

  dom: {
    html: string;             // rendered HTML snapshot (post-JS for tier 2/3 & extension)
    domHash: string;          // stable hash for change detection (see monitor)
    selectorsOfInterest?: ElementRef[]; // adaptive-tracked elements (Scrapling)
  };

  network: NetworkCapture[];   // XHR/fetch calls observed - the highest-signal input
  meta: {
    title?: string;
    robotsAllowed?: boolean;  // scraper only
    renderedWithJs: boolean;
  };
}

interface NetworkCapture {
  method: string;             // GET/POST/...
  urlPattern: string;         // templated: /api/items/{id}
  rawUrl: string;
  requestHeaders: Record<string, string>;   // SANITIZED - see 04. FAIL-CLOSED: the zod schema REJECTS any
                                             // secret-list header, so an un-scrubbed producer throws at parse().
  requestBodySchema?: JsonSchema;            // inferred shape, not raw values
  responseSchema?: JsonSchema;               // inferred shape of response
  statusCode: number;
  contentType: string;
}

interface ElementRef {        // Scrapling adaptive tracking handle
  role: string;               // e.g. "search-input", "submit-button"
  selector: string;
  fallbackSelectors?: string[];
}
```

**Producers:** scraper, extension net-intercept. **Consumer:** generator (inference).
**Fixture:** `fixtures/capture-bundles/*.json` - every other consumer test loads these, never a live fetch.

---

## 2. ToolDefinition - output of inference, input to codegen

```ts
interface InferenceResult {
  url: string;
  bundleId: string;
  tools: ToolDefinition[];
  confidence: number;         // 0..1 - aggregate; see S5 confidence rules
  modelVersion: string;       // Claude model id used
}

interface ToolDefinition {
  name: string;               // snake_case, unique within server
  description: string;        // LLM-facing
  inputSchema: JsonSchema;    // zod-validated params (validate with zod at gen time)
  execution: ExecutionStrategy;
  confidence: number;         // 0..1 per-tool
}

type ExecutionStrategy =
  | { kind: 'http';   request: NetworkCapture; paramMapping: ParamMapping }   // call discovered API directly
  | { kind: 'browser'; steps: BrowserStep[] };                               // drive a headless page (Playwright)

// -- v1 SCOPE DECISION (frozen) ------------------------------------------------
// v1 generates execution for PUBLIC tools only. There is intentionally NO runtime
// auth-acquisition field on ExecutionStrategy. session-mode traffic is still
// CAPTURED (for inference signal), but generated tools in v1 execute only against
// public endpoints. Authenticated session-mode EXECUTION is post-v1 and will add a
// runtime-auth field (e.g. browser_replay / local_broker) at that time - it is a
// breaking, deliberate contract extension, not an oversight. Do not invent it now.

interface ParamMapping {       // how ToolDefinition.inputSchema fields fill the request
  [paramName: string]: { in: 'path' | 'query' | 'header' | 'body'; key: string };
}

interface BrowserStep {
  action: 'navigate' | 'fill' | 'click' | 'waitFor' | 'extract';
  target?: ElementRef;
  value?: string;             // may reference a param via {{paramName}}
}
```

**Producer:** generator (Claude inference). **Consumer:** generator (codegen). zod schema is the
validation gate - inference output that fails zod is rejected before codegen.

---

## 3. GeneratedServerArtifact - output of codegen

```ts
interface GeneratedServerArtifact {
  serverId: string;
  version: number;
  files: { path: string; content: string }[];  // server.ts, claude_desktop_config.json, README
  entrypoint: string;                            // e.g. "server.ts"
  configSnippet: string;                         // claude_desktop_config.json fragment user pastes
  artifactUrl?: string;                          // R2 location once uploaded (see 02)
}
```

**Producer:** generator (codegen). **Consumers:** web (download), R2 (storage), Postgres (version row).

---

## 4. Queue messages - Go produces, Node consumes

BullMQ on Redis. Go enqueues, Node workers process. **This is the only coupling between monitor and
generator**, and it is async. Queue name + payloads are frozen here.

```ts
type JobKind = 'generate' | 'regenerate' | 'self_heal';

interface GenerateJob   { kind: 'generate';   url: string; legalMode: LegalMode; requestedBy: string; bundle?: CaptureBundle; }
interface RegenerateJob { kind: 'regenerate'; serverId: string; reason: 'large_drift' | 'manual'; }
interface SelfHealJob   { kind: 'self_heal';  serverId: string; toolName: string; failure: ToolFailure; }

interface ToolFailure {
  toolName: string;
  errorClass: 'selector_miss' | 'http_4xx' | 'http_5xx' | 'schema_mismatch' | 'timeout';
  detail: string;
  observedAt: string;
}
```

- Queue: `mcp-jobs` (single queue, discriminated by `kind`) - or one queue per kind; implementer decides,
  but the **payload shapes above are fixed**.
- Go monitor only ever produces `regenerate` and `self_heal`. `generate` comes from web/extension API.

---

## 5. Registry / Version / Confidence - DB row shapes

Read by web + monitor; written by generator. Full DDL in `02-data-model.md`; the logical shape:

```ts
interface RegistryEntry {
  serverId: string;
  url: string;
  title: string;
  tier: 'curated' | 'auto_gen';     // curated = hand-verified; see registry/library layer
  confidence: number;               // 0..1, surfaced in UI
  installCount: number;
  lastParsedAt: string;
  status: 'active' | 'degraded' | 'broken' | 'regenerating';
  currentVersion: number;
}

interface ServerVersion {
  serverId: string;
  version: number;
  artifactUrl: string;              // R2
  toolCount: number;
  createdAt: string;
  createdBy: 'auto' | 'self_heal' | 'community' | string;
}
```

**Confidence rules (single source of truth - referenced by generator + monitor + web):**
- Per-tool confidence from inference (S2). Aggregate = mean of per-tool confidences, clamped to [0,1].
  **Implemented once** as `aggregateConfidence()` in `packages/types` - generator/monitor/web import it,
  never reimplement. (v1 equal weights; refine weighting in that one place if needed.)
- Monitor adjusts confidence on health-check results (pass ^, fail v). Bounds [0,1].
- Curated tier is **always >= 0.95** by definition (hand-verified). Auto-gen displays live confidence.

---

## 6. LegalMode - cross-cutting enum (policy in 04)

```ts
type LegalMode = 'safe' | 'full_scrape' | 'session';
```

Carried on `CaptureBundle` and `GenerateJob`. Enforcement points are in `04-legal-modes.md`; the **enum
is fixed here** so scraper, extension, generator and web all agree on the value space.

> **v1 scope:** all three modes are valid for **capture**. But `session`-mode **execution** is post-v1
> (see `ExecutionStrategy` note in S2). In v1, a `session` capture improves inference; the generated tool
> still executes against public endpoints only.

---

## 7. Web API surface - what web & extension call

Frozen route list (full request/response in `apps/web.md`; shapes reference this doc):

```
POST /api/generate        body { url, legalMode, acknowledgedFullScrape?, bundle? } -> { jobId }   (enqueues GenerateJob)
                            - acknowledgedFullScrape MUST be true when legalMode==='full_scrape' (04); schema-enforced
                            - bundle is an optional extension CaptureBundle; if present the worker generates from it
                              instead of a server-side scraper re-fetch
GET  /api/jobs/:jobId      -> { status: 'queued'|'running'|'done'|'failed', result?: GeneratedServerArtifact, error? }
GET  /api/registry         query { tier?, q? } -> RegistryEntry[]
GET  /api/servers/:id      -> RegistryEntry & { versions: ServerVersion[] }
POST /api/servers/:id/contribute  body { bundle: CaptureBundle }   (extension passive contribution / community)
GET  /api/servers/:id/download/:version -> GeneratedServerArtifact
POST /api/assist          body { messages, pageContext, availableTools } -> streamed turn  (side panel; keeps Claude key server-side)
```

> Canonical zod shapes for these live in `packages/types` (`api.ts`): `GenerateRequest` (with the
> `full_scrape` acknowledgement refine), `GenerateResponse`, `JobStatusResponse`, `ContributeRequest`.

The extension and web app **only** know these routes - they never call scraper/generator/monitor directly.

---

## Cross-language sync

- TS is canonical in `packages/types` (zod schemas -> can emit JSON Schema).
- **Python (scraper):** consumes nothing inbound except a `GenerateJob`-like trigger; **produces**
  `CaptureBundle`. Keep a `pydantic` mirror of `CaptureBundle` + `NetworkCapture`.
- **Go (monitor):** produces queue messages (S4), reads/writes registry rows (S5). Keep Go structs
  mirroring S4 and S5 only.
- **Open question:** auto-generate Python/Go mirrors from zod->JSON Schema, or hand-maintain with a
  contract test that fails CI on drift? Recommend the latter for v1 (a golden-fixture round-trip test).

## Open questions
- `JsonSchema` representation: full JSON Schema draft, or a trimmed subset? Pick one and validate with the
  same lib on both producer and consumer.
- Header sanitization list (what counts as a secret) - defined in `04`, referenced by the `NetworkCapture` producer.
