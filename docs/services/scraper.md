# Service - Scraper (Python / Scrapling)

## Purpose
Fetch a target URL and produce a **`CaptureBundle`** (`01-contracts.md S1`) - a rendered DOM snapshot
plus observed network calls - using a 3-tier escalation strategy with adaptive element healing. It is the
server-side capture source; the extension net-intercept is the client-side one producing the same shape.

## Inputs / Outputs
- **Input:** a fetch request `{ url, legalMode }` (from generator; sync HTTP for v1 - see `03` open Q).
- **Output:** `CaptureBundle` (`01 S1`). `source: 'scraper'`, `tier` set to the tier that succeeded.
- Mirrors `CaptureBundle` + `NetworkCapture` as **pydantic** models (`01 SCross-language`).

## Dependencies
- **Scrapling `[fetchers]` 0.4.8** - `Fetcher` (tier 1), `DynamicFetcher` (tier 2, Playwright/Chromium),
  `StealthyFetcher` (tier 3, Camoufox/Firefox). The extra also pulls `curl_cffi` (tier-1 HTTP client).
  Browser binaries: `python -m playwright install chromium` (tier 2); Camoufox setup for tier 3.
- Decoupled from everything else: it returns a bundle and knows nothing about Postgres/queue/Claude.

## The three tiers (escalate only on failure)
Mapped to the **real Scrapling 0.4.8 classes** (verified from source - reconciles the older names above):
1. **Tier 1 - `Fetcher.get`.** Static HTTP, no browser. Cheapest. No XHR capture (`network == []`).
2. **Tier 2 - `DynamicFetcher.fetch`.** Playwright/Chromium. Renders JS and **captures load-time XHR/fetch**.
3. **Tier 3 - `StealthyFetcher.fetch`.** Camoufox/Firefox, max stealth for aggressive anti-bot. Same shape as tier 2.

Escalation is bounded: tier1->2->3; if all fail, return a content-free bundle and let the generator mark the
server `broken` (low confidence). Never loop forever.

> **Network-capture mechanism (verified against a real Chromium).** Use a `page_setup` callback (runs
> **before** navigation) to register `page.on("response")` and read method+url+status+headers+body from the
> raw Playwright response. Do **not** use Scrapling's native `capture_xhr`: `""` is coerced to disabled, and
> its wrapped Response drops the HTTP method (POST endpoints would be mislabeled GET). `page_action` runs
> *after* nav and misses load-time XHR. See `services/scraper/scraper/tiers.py`.

## Adaptive element tracking (self-healing selectors)
Scrapling tracks elements by role so selectors survive markup changes - populate
`dom.selectorsOfInterest: ElementRef[]` (`01 S1`) with `role` + `selector` + `fallbackSelectors`. This
feeds both inference (better tool steps) and the generator's self-heal path.

> **v1 status: STUB.** `_selectors_of_interest` currently does a plain `.css()` existence check against a
> couple of hardcoded role->selector guesses - it does **not** yet use Scrapling's `adaptive=True` /
> `identifier=` / `auto_save=` machinery and emits no `fallbackSelectors`. Satisfies the shape, not the
> intent. Wire real adaptive tracking before relying on the self-heal selector path.

## Network capture (highest-signal input)
Capture XHR/fetch during tier 2/3, template URLs (`/api/items/{id}`), infer request/response **schemas**
(not raw values), emit `NetworkCapture[]`. **Apply the `04` secret-list scrub before returning** - strip
auth headers, never persist credentials.

## Legal enforcement (see `04-legal-modes.md`)
- `safe` (default): fetch & honor `robots.txt`; if disallowed -> return bundle with
  `meta.robotsAllowed=false` and **no content**.
- `full_scrape`: only when the request carries the acknowledgement flag; public pages only; no session.
- Scraper has **no credential inputs** by design. It never does `session` mode (that's extension-only).

## Data touchpoints
- Reads: nothing persistent (may read a Redis rate-limit key `rl:{host}`, `02`).
- Writes: nothing directly; returns the bundle to the caller.

## Implementation steps
1. Define pydantic mirrors of `CaptureBundle`/`NetworkCapture`/`ElementRef`.
2. Tier-1 fetcher -> DOM hash + HTML.
3. robots.txt gate for `safe` mode.
4. Tier-2 Playwright fetcher with network interception + selector-of-interest extraction.
5. Tier-3 Camoufox fetcher.
6. Escalation controller (try 1->2->3, bounded, record `tier`).
7. Secret-list scrubber (shared constant, `04`).
8. HTTP endpoint (`POST /capture`) returning the bundle.

## How to test in isolation
- Serve local fixture HTML pages (static + a JS-rendered SPA fixture) - no live internet needed.
- Assert: tier escalation picks the right tier; `robots.txt` disallow yields empty content; secret-list
  headers are stripped from output; output validates against the `CaptureBundle` schema.
- Golden test: fixture page -> expected `CaptureBundle` JSON (round-trips the `01` contract).

## Acceptance criteria
- Given a JS-rendered fixture, output contains the SPA's API calls as `NetworkCapture[]`.
- `safe` + disallowed path => zero content, `robotsAllowed=false`.
- No secret-list header ever appears in output.
- Output validates against the canonical `CaptureBundle` schema (contract round-trip test passes).

## Status (implemented)
- Built and tested in isolation (`services/scraper/`, 27 tests). Browser-free core fully verified:
  contract round-trip (golden corpus, incl. rejection, fail-closed secret-header rejection, and url/uuid/
  datetime parity matching the TS zod), scrub parity, escalation with fakes (incl. shell->tier-2),
  URL templating, schema inference, robots gate, FastAPI legal gating, tier-1 real fetch.
- **Tier-2 network capture VERIFIED against a real Chromium** both directly AND through the integrated
  `EscalationController` path: a 200 SPA shell escalates to tier 2 and its load-time XHR is captured with
  method, templated, schema-inferred, into a contract-valid bundle.
- **Escalation success predicate:** a tier-1 200 is sufficient only for genuinely static pages; a
  script-driven shell escalates to a browser tier (else the high-signal SPA case yields `network:[]`).
- **Tier 3 (Camoufox/`StealthyFetcher`) is code-complete but UNVERIFIED** - shares the exact verified
  `page_setup` capture path as tier 2; only `StealthyFetcher.fetch` + the Camoufox browser binary are
  unexercised here. Verify before relying on it.

## Bot-wall handling
A page can return HTTP 200 yet be a captcha/anti-bot challenge (Amazon, Cloudflare, PerimeterX). `is_sufficient`
treats a bot-walled result (markers in `looks_like_bot_wall`) as insufficient, so the controller escalates a
plain-HTTP tier-1 hit to the stealthier browser tiers, which may pass the challenge. If every tier is walled,
it returns best-effort (the content tool still works against the live URL).
> **Latency cost:** a genuinely walled site runs tier1 -> tier2 (browser, ~10s) -> tier3 before the best-effort
> fallback (~20s+), and leans on the tier-3/Camoufox path that is code-complete but unverified (no binary here).
> Acceptable for v1 (graceful), but tune the per-tier timeout / cap escalation if walled sites are common.

## Open questions
- Camoufox browser binary install + a gated tier-3 capture test (deferred per scope).
- Sync HTTP vs. sub-queue interface to generator (`03` open Q).
