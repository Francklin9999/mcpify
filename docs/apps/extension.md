# App - Extension (TypeScript / Plasmo)

## Purpose
The Chrome extension is **three separable things** in one MV3 package. Keep them in distinct internal
modules - they blur easily and must not.

1. **Popup** (funnel) - one-click "generate MCP from this tab".
2. **Side panel** (the long-term product) - LLM chat about the current page + page-action autocomplete.
3. **Net-intercept** (a generation data source) - silently records traffic -> a `CaptureBundle`.

## Inputs / Outputs
- **Net-intercept output:** `CaptureBundle { source:'extension' }` - **identical shape to the scraper's
  output** (`01 S1`). This is the decoupling: the generator can't tell where a bundle came from.
- Calls the Web API (`01 S7`) only - `POST /api/generate`, `POST /api/servers/:id/contribute`. Never
  talks to scraper/generator/monitor directly.

## Dependencies
- **Plasmo** (primary) or **WXT** (alternative) - MV3 extension framework, React + TypeScript.
- **`chrome.webRequest`** (+ `chrome.scripting` for DOM snapshot) - network interception.
- **`packages/types`** - the `CaptureBundle` contract + shared **secret-list** scrub constant (`04`).
- An LLM endpoint for the side panel chat (via the Web API or a dedicated assist endpoint - decide).

## Module 1 - Popup (funnel)
- Reads the active tab URL. Button -> `POST /api/generate { url, legalMode:'session'|'safe' }`.
- Popup generation may remain URL-only; the side panel is the richer path because it can assemble the live
  DOM/network `CaptureBundle` immediately before enqueueing.
- Inherits the user's browser session (no separate auth). Shows history of past generated servers.
- This is the conversion surface into the side panel.

## Module 2 - Side panel (the product) - PRIORITY SURFACE

The user's stated long-term product. Specced in depth so it is not the thin module. Four sub-systems:

### 2a. LLM transport
- Chat goes through the **Web API** via a dedicated assist route - **add `POST /api/assist`** to the
  surface in `01 S7` (request: `{ messages, pageContext, availableTools }` -> streamed assistant turn).
  Rationale: keep the Anthropic key server-side (never ship it in the extension), enable prompt caching
  (Claude API skill) on the system prompt + page-context preamble, and centralize rate limiting.
- Stream tokens to the panel (SSE/stream). The extension holds **no** model credentials.

### 2b. Page-context mechanism (what the model "sees")
- On each turn, build a **compact page context** from the live tab: visible text outline (headings/labels),
  the `ElementRef[]` of actionable elements (reuse the `01 S1` `ElementRef` shape), current URL, and a
  short slice of recent `NetworkCapture[]` from Module 3. **Apply the `04` secret-list scrub** before it
  leaves the client - page context can contain PII/secrets.
- Budget the context (token cap); summarize/trim deterministically so caching stays effective.

### 2c. Action-autocomplete model
- As the user works, suggest the **next page action** as a concrete tool call (e.g. "fill search =
  '...' -> click Submit"). Surface it as an accept/dismiss chip in the panel.
- An accepted suggestion maps to a `BrowserStep[]` (`01 S2`) executed in the live tab via
  `chrome.scripting` - the same step vocabulary the generator emits, so suggestions and generated tools
  share one execution path. (Honors the v1 public-execution scope; no credentialed replay.)

### 2d. Chat <-> tool-call bridge
- The assistant can call tools: (1) **page actions** (`BrowserStep[]` executed locally in the tab), and
  (2) **already-generated MCP tools** for this site (looked up via `GET /api/servers/:id`). Tool results
  flow back into the conversation. This is what makes the panel *act*, not just chat.
- Tool-call execution is local and visible; the user confirms actions that mutate state.

> Network capture runs **silently in the background** the whole time the panel is open (feeds Module 3).
> Treat this surface's UX as primary - it is the everyone-surface and the long-term product.

## Module 3 - Net-intercept (data source)
- `chrome.webRequest` captures XHR/fetch as the user browses real, complex (SPA) sites - the best signal.
- Build a `CaptureBundle`: DOM snapshot + `NetworkCapture[]` with **inferred schemas, not raw values**.
- Side-panel generation posts this bundle to `POST /api/generate { url, legalMode:'session', bundle }`; the
  worker uses it directly instead of doing a weaker server-side re-fetch.
- **`session` mode** uses existing browser cookies *implicitly* - the extension **never reads, exports,
  or transmits cookies/credentials** (`04`). Apply the shared **secret-list scrub** before anything leaves
  the client. CAPTCHAs on auth walls are never automated.
- Passive contribution: `POST /api/servers/:id/contribute { CaptureBundle }` -> flywheel (`03` Flow C).

> **v1 scope (frozen decision):** session-mode traffic is **captured** for inference signal, but generated
> tools **execute against public endpoints only** in v1. There is no runtime-auth replay yet - see the
> `ExecutionStrategy` note in `01 S2`. Authenticated session **execution** is a deliberate post-v1 extension.

## Legal enforcement (see `04-legal-modes.md`)
- Default to least-invasive mode. `session` mode = user's own logged-in account only.
- **Hard rule:** no credential/cookie/secret ever leaves the client. Scrub via the shared secret-list
  constant so scraper and extension scrub identically. Add a test asserting no secret-list field is transmitted.

## Data touchpoints
- Local only (chrome.storage for history/state). Server interaction is exclusively via `01 S7` routes.

## Implementation steps
1. Plasmo MV3 scaffold: popup + side panel + background service worker.
2. `chrome.webRequest` listener -> request/response schema inference (not raw values).
3. DOM snapshot via `chrome.scripting` -> assemble `CaptureBundle` (shared type).
4. Secret-list scrubber (shared constant, `04`) applied before any transmission.
5. Popup generate flow -> URL-only `POST /api/generate`.
6. Side panel chat + page-action autocomplete UI.
7. Side-panel generate flow -> build live `CaptureBundle`, then `POST /api/generate`.
8. Passive contribution flow -> `POST /api/servers/:id/contribute`.

## How to test in isolation
- Use **recorded page sessions** (HAR-like fixtures) to drive net-intercept without live browsing.
- Assert: assembled `CaptureBundle` validates against the `01 S1` schema and is byte-identical in shape to
  a scraper bundle; secret-list headers/fields are stripped; popup posts a well-formed `/api/generate`
  body. Mock the Web API (MSW).
- No backend needed - assert on the outgoing request payloads.

## Acceptance criteria
- Net-intercept produces a `CaptureBundle` indistinguishable in shape from the scraper's (same contract).
- No cookie/credential/secret-list field is ever included in a transmitted bundle (tested).
- Popup one-click enqueues a `GenerateJob` via the API; side panel renders page-scoped chat + autocomplete.
- The three modules are separate code units (popup / side panel / net-intercept), not intermixed.

## Open questions (verify before coding)
- **Plasmo vs. WXT** final choice + current MV3 `chrome.webRequest` capabilities (MV3 restricts blocking
  webRequest - verify observation-only is supported) - verify before coding.
- ~~Exactly how `session`-mode requests are replayed by generated tools~~ - **resolved: out of v1 scope**
  (public-only execution; see `01 S2`). Revisit when designing post-v1 session execution.
