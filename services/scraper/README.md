# mcp-scraper

Scrapling 3-tier fetcher -> `CaptureBundle`. Spec: [`docs/services/scraper.md`](../../docs/services/scraper.md).
The server-side capture source; the extension net-intercept produces the same `CaptureBundle` shape (`01 S1`).

## Layout

| Module | Role |
|--------|------|
| `contracts.py` | pydantic mirror of `CaptureBundle`/`NetworkCapture`/`ElementRef` (`01 S1`), with the **fail-closed** secret-header rejection mirroring the TS `superRefine`. |
| `legal.py` | reads the **same** `packages/types/src/secret-list.json` the TS side uses; identical glob->regex scrub. |
| `capture.py` | pure core - escalation controller (over a `Fetcher` protocol), URL templating, schema inference, bundle assembly. No browser imports. |
| `tiers.py` | Scrapling-backed tier fetchers (lazy import): `Fetcher`/`DynamicFetcher`/`StealthyFetcher`. |
| `robots.py` | robots.txt gate for `safe` mode (injectable fetch). |
| `service.py` | FastAPI `POST /capture` -> `CaptureBundle`. Legal gating (safe/full_scrape/session). |

## Tiers (real Scrapling 0.4.8 classes)

1. **`Fetcher.get`** - static HTTP, no browser, `network == []`.
2. **`DynamicFetcher.fetch`** - Playwright/Chromium; **captures load-time XHR/fetch** (the high-signal path).
3. **`StealthyFetcher.fetch`** - Camoufox/Firefox, max stealth. Code-complete, **unverified** (no Camoufox binary here).

## Verified facts (don't rediscover these)

- **Network capture uses a `page_setup` hook, NOT `capture_xhr`.** `page_setup` runs *before* navigation, so
  `page.on("response")` catches load-time XHR (`page_action` runs after nav and misses them). Scrapling's
  native `capture_xhr` is a trap: `""` is coerced to *disabled*, and its wrapped Response **drops the HTTP
  method** - POST endpoints would be mislabeled GET. We read method+url+status+headers+body off the raw
  Playwright response. All verified against a real Chromium in `tests/test_tiers_real.py`.
- **Escalation stops at the first *sufficient* tier, not the first 200.** A tier-1 200 that's a script-driven
  shell (little visible text) is insufficient - escalation continues to a browser tier so XHR is captured.
  Otherwise the integrated `/capture` path would yield `network:[]` on exactly the SPA sites the product
  targets. A best-effort fallback keeps the tier-1 shell if browser tiers are unavailable.
- **Install needs `scrapling[fetchers]`** (curl_cffi is required even for the static tier-1 client) **plus**
  `python -m playwright install chromium`. The `[fetchers]` extra pins `playwright==1.59.0` - install the
  browser *after* that extra, or you get a stale-revision launch error.

## Setup / test

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m playwright install chromium      # for tier 2
pytest                                       # 22 tests; tier-2 capture runs if Chromium launches, else SKIPS loudly
```

The tier-2 capture test **skips with a loud reason** if Chromium can't launch - it is never silently
passed. If skipped, network capture (the product's high-signal path) is UNVERIFIED in that environment.

## Next unit (deferred)

- Camoufox binary + a gated tier-3 capture test.
- The generator calls this over sync HTTP (`03`); the Node `Scraper` port adapter belongs to the integration worker unit.
