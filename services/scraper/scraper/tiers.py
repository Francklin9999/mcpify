"""Scrapling-backed tier fetchers (docs/services/scraper.md).

Tier classes map to the REAL Scrapling 0.4.8 API (verified from source - reconciles the doc's older
class names):
  Tier 1 -> Fetcher.get        (static HTTP; no JS, no network capture)
  Tier 2 -> DynamicFetcher.fetch(capture_xhr=...)   (Playwright/Chromium; native XHR capture)
  Tier 3 -> StealthyFetcher.fetch(capture_xhr=...)  (Camoufox/Firefox; max stealth)

Scrapling is imported lazily inside methods so the pure core + its tests never need a browser.
`capture_xhr` is a real native kwarg; the returned Response exposes `.captured_xhr` (Playwright Response
objects with `.request.method/.url`, `.status`, `.headers`).
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .capture import FetchResult, RawNetworkCall
from .contracts import ElementRef

# Why page_setup instead of Scrapling's native capture_xhr:
#   - capture_xhr="" is coerced to None (disabled); ".*" captures, BUT the wrapped Response drops the HTTP
#     method (`.request` is None) - and method matters: POST endpoints are the action-capable tools.
#   - page_setup runs BEFORE navigation, so our page.on("response") catches LOAD-TIME XHR (page_action runs
#     after nav and would miss them). The raw Playwright response gives method + url + status + headers + body.
# All verified against a real Chromium (tests/test_tiers_real.py).

_MAX_JSON_BODY_BYTES = 512_000


def _selectors_of_interest(page: Any) -> list[ElementRef]:
    """Best-effort adaptive-tracked elements. Cheap, never raises (Scrapling adaptive heals selectors)."""
    refs: list[ElementRef] = []
    roles = {
        "search-input": "input[type=search], input[name*=q], input[name*=search]",
        "submit-button": "button[type=submit], input[type=submit]",
    }
    for role, selector in roles.items():
        try:
            if page.css(selector):
                refs.append(ElementRef(role=role, selector=selector))
        except Exception:
            pass
    return refs


def _make_network_capturer() -> tuple[Any, list[RawNetworkCall]]:
    """Return (page_setup_callable, calls). The callable registers a response listener BEFORE navigation
    so load-time XHR/fetch are caught. Reads method+url+status+headers+body from the raw Playwright response.
    """
    calls: list[RawNetworkCall] = []

    def small_json_response(resp: Any, headers: dict[str, str]) -> Any:
        content_type = headers.get("content-type", "")
        if "json" not in content_type.lower():
            return None
        try:
            content_length = int(headers.get("content-length") or "0")
        except ValueError:
            content_length = 0
        if content_length > _MAX_JSON_BODY_BYTES:
            return None
        try:
            return resp.json()
        except Exception:
            return None

    def request_json_body(req: Any) -> Any:
        try:
            headers = dict(req.headers or {})
            content_type = headers.get("content-type", "")
            if "json" not in content_type.lower():
                return None
            raw = getattr(req, "post_data", None)
            if callable(raw):
                raw = raw()
            if not raw or len(str(raw).encode("utf-8")) > _MAX_JSON_BODY_BYTES:
                return None
            return json.loads(str(raw))
        except Exception:
            return None

    def page_setup(page: Any) -> None:
        def on_response(resp: Any) -> None:
            try:
                req = resp.request
                if req.resource_type not in ("xhr", "fetch"):
                    return
                resp_headers = dict(resp.headers or {})
                body = small_json_response(resp, resp_headers)
                calls.append(
                    RawNetworkCall(
                        method=str(req.method).upper(),
                        raw_url=resp.url,
                        request_headers=dict(req.headers or {}),
                        status_code=int(resp.status),
                        content_type=resp_headers.get("content-type", ""),
                        request_body=request_json_body(req),
                        response_body=body,
                    )
                )
            except Exception:
                pass  # never let a capture error break the fetch

        page.on("response", on_response)

    return page_setup, calls


class Tier1Fetcher:
    """Static HTTP. No JS, no XHR capture (network == [])."""

    tier = 1

    def fetch(self, url: str) -> Optional[FetchResult]:
        from scrapling.fetchers import Fetcher

        resp = Fetcher.get(url, stealthy_headers=True, timeout=10, retries=1)
        if resp is None or getattr(resp, "status", 0) >= 400:
            return None
        return FetchResult(
            html=str(resp.html_content),
            status=int(resp.status),
            rendered_with_js=False,
            network=[],
            selectors_of_interest=_selectors_of_interest(resp),
            title=_title(resp),
        )


class Tier2Fetcher:
    """Playwright/Chromium with native XHR capture - the high-signal tier."""

    tier = 2

    def fetch(self, url: str) -> Optional[FetchResult]:
        from scrapling.fetchers import DynamicFetcher

        page_setup, calls = _make_network_capturer()
        resp = DynamicFetcher.fetch(url, network_idle=True, page_setup=page_setup, headless=True, timeout=10_000, retries=1)
        if resp is None:
            return None
        return FetchResult(
            html=str(resp.html_content),
            status=int(getattr(resp, "status", 200)),
            rendered_with_js=True,
            network=list(calls),
            selectors_of_interest=_selectors_of_interest(resp),
            title=_title(resp),
        )


class Tier3Fetcher:
    """Camoufox/Firefox max-stealth, with native XHR capture. Same shape as tier 2."""

    tier = 3

    def fetch(self, url: str) -> Optional[FetchResult]:
        from scrapling.fetchers import StealthyFetcher

        page_setup, calls = _make_network_capturer()
        resp = StealthyFetcher.fetch(url, network_idle=True, page_setup=page_setup, headless=True, timeout=10_000, retries=1)
        if resp is None:
            return None
        return FetchResult(
            html=str(resp.html_content),
            status=int(getattr(resp, "status", 200)),
            rendered_with_js=True,
            network=list(calls),
            selectors_of_interest=_selectors_of_interest(resp),
            title=_title(resp),
        )


def _title(resp: Any) -> Optional[str]:
    try:
        found = resp.css("title::text")
        return str(found[0]) if found else None
    except Exception:
        return None
