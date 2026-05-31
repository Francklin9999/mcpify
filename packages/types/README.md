# @mcp/types

Keystone shared contracts for the platform. **Schemas (zod) are the source of truth; TS types are
`z.infer`red** so runtime validation and compile-time types can't drift. Spec: [`docs/01-contracts.md`](../../docs/01-contracts.md).

## Use

```ts
import { CaptureBundle, ToolDefinition, Job, GenerateRequest, scrubHeaders, QUEUE_NAME } from "@mcp/types";

const bundle = CaptureBundle.parse(input);        // throws on invalid
const res = ToolDefinition.safeParse(maybeTool);  // { success, data | error }
```

## What's here

| Module | Exports |
|--------|---------|
| `common` | `JsonSchema`, `IsoDateTime`, `Confidence`, `clampConfidence` |
| `legal` | `LegalMode`, `scrubHeaders`, `isSecretHeader/Field`, `SECRET_HEADERS` |
| `capture` | `CaptureBundle`, `NetworkCapture`, `ElementRef` |
| `tools` | `ToolDefinition`, `ExecutionStrategy`, `InferenceResult`, `ParamMapping`, `BrowserStep` |
| `artifact` | `GeneratedServerArtifact`, `GeneratedFile` |
| `queue` | `Job`, `GenerateJob`, `RegenerateJob`, `SelfHealJob`, `ToolFailure`, `QUEUE_NAME` |
| `registry` | `RegistryEntry`, `ServerVersion`, `ServerTier`, `ServerStatus` |
| `api` | `GenerateRequest`, `JobStatusResponse`, `ContributeRequest`, … |

## Cross-language sync

- **`src/secret-list.json`** is the canonical, language-neutral secret-list. The Python scraper reads this
  **exact file** (do not fork it). Re-implement `globToRegExp`/`scrubHeaders` against the same list.
- **`/fixtures/`** (repo root) is a cross-language golden corpus: the TS tests here and the future
  Python/Go contract tests load the same JSON. Keeping them passing in all three runtimes is how the
  hand-maintained mirrors are kept honest (`01 §Cross-language`).

## Build / test

```bash
npm run build --workspace=@mcp/types   # tsc → dist/ (+ copies secret-list.json)
npm run test  --workspace=@mcp/types   # round-trip + REJECTION + scrub + legal-gate + confidence
```
