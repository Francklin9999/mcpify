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

import asyncio
import json
import os
import re
from typing import Any, Optional

from .capture import FetchResult, RawNetworkCall
from .contracts import ElementRef
from .ssrf import url_allowed

# Why page_setup instead of Scrapling's native capture_xhr:
#   - capture_xhr="" is coerced to None (disabled); ".*" captures, BUT the wrapped Response drops the HTTP
#     method (`.request` is None) - and method matters: POST endpoints are the action-capable tools.
#   - page_setup runs BEFORE navigation, so our page.on("response") catches LOAD-TIME XHR (page_action runs
#     after nav and would miss them). The raw Playwright response gives method + url + status + headers + body.
# All verified against a real Chromium (tests/test_tiers_real.py).

_MAX_JSON_BODY_BYTES = 512_000


def _response_url(resp: Any, fallback: str) -> str:
    value = getattr(resp, "url", None) or getattr(resp, "final_url", None) or fallback
    return str(value)


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
        try:
            page.route("**/*", lambda route, request: route.abort() if not url_allowed(str(request.url)) else route.continue_())
        except Exception:
            pass

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


# How many times the interaction pass scrolls to the bottom to trigger lazy-load / infinite-scroll XHR.
_INTERACT_SCROLLS = 2


def _interaction_enabled() -> bool:
    return os.getenv("SCRAPER_INTERACT", "1").strip().lower() not in {"0", "false", "no", "off"}


def _settle(page: Any) -> None:
    """Wait briefly for triggered XHR to fire/settle; never raises."""
    try:
        page.wait_for_load_state("networkidle", timeout=2_500)
    except Exception:
        try:
            page.wait_for_timeout(500)
        except Exception:
            pass


def _make_interaction_action() -> Any:
    """A Scrapling ``page_action`` (runs after navigation) that performs bounded, fail-soft interactions
    (scroll, search-submit, load-more) to surface XHR that only fires on user action. The page.on("response")
    listener stays active, so traffic from these actions is captured. Disable with SCRAPER_INTERACT=0.
    """

    def page_action(page: Any) -> Any:
        if not _interaction_enabled():
            return page

        # A search submit or <a> "Next" can fully navigate away, which would change the analyzed DOM and break
        # relative-URL resolution. We still want the click (it surfaces XHR), so we restore the start URL after.
        start_url = None
        try:
            start_url = page.url
        except Exception:
            start_url = None

        # 1) Scroll to the bottom a few times - triggers lazy-loaded / infinite-scroll endpoints (same page).
        for _ in range(_INTERACT_SCROLLS):
            try:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                break
            _settle(page)

        # 2) Submit the primary search box - surfaces the search/query endpoint (often an XHR on SPAs).
        try:
            box = page.query_selector(
                "input[type=search], input[name*='q' i], input[name*='search' i], "
                "input[name*='query' i], input[placeholder*='search' i], [role=searchbox]"
            )
            if box is not None:
                box.fill("test")
                box.press("Enter")
                _settle(page)
        except Exception:
            pass

        # 3) Click a 'load more' / 'next' control - surfaces pagination endpoints. Curated, consent-free
        #    selectors only (never an arbitrary button, so we don't trip sign-up / destructive actions).
        try:
            more = page.query_selector(
                "button:has-text('Load more'), button:has-text('Show more'), button:has-text('See more'), "
                "a[rel=next], a:has-text('Next'), [aria-label*='next' i]"
            )
            if more is not None:
                more.click(timeout=2_000)
                _settle(page)
        except Exception:
            pass

        # Restore the requested document if an interaction navigated away, so the analyzed DOM (and its
        # relative-link base) matches the URL the bundle records. Compare ignoring the #fragment.
        try:
            if start_url and _strip_fragment(page.url) != _strip_fragment(start_url):
                page.goto(start_url, wait_until="domcontentloaded")
                _settle(page)
        except Exception:
            pass

        return page

    return page_action


def _strip_fragment(url: str) -> str:
    return str(url or "").split("#", 1)[0]


class Tier1Fetcher:
    """Static HTTP. No JS, no XHR capture (network == [])."""

    tier = 1

    def fetch(self, url: str) -> Optional[FetchResult]:
        from scrapling.fetchers import Fetcher

        resp = Fetcher.get(url, stealthy_headers=True, timeout=10, retries=1)
        if resp is None or getattr(resp, "status", 0) >= 400:
            return None
        if not url_allowed(_response_url(resp, url)):
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
        resp = DynamicFetcher.fetch(
            url, network_idle=True, page_setup=page_setup, page_action=_make_interaction_action(), headless=True, timeout=10_000, retries=1
        )
        if resp is None:
            return None
        if not url_allowed(_response_url(resp, url)):
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
        resp = StealthyFetcher.fetch(
            url, network_idle=True, page_setup=page_setup, page_action=_make_interaction_action(), headless=True, timeout=10_000, retries=1
        )
        if resp is None:
            return None
        if not url_allowed(_response_url(resp, url)):
            return None
        return FetchResult(
            html=str(resp.html_content),
            status=int(getattr(resp, "status", 200)),
            rendered_with_js=True,
            network=list(calls),
            selectors_of_interest=_selectors_of_interest(resp),
            title=_title(resp),
        )


# Tier 4: nodriver + CDP. Real Chrome via CDP for max stealth + a full XHR/fetch network log (method, headers,
# body). Env: SCRAPER_NODRIVER=0 to disable, SCRAPER_NODRIVER_CHROME=<path>, SCRAPER_NODRIVER_HEADFUL=1.
_NODRIVER_WAIT_S = 3.0
_NODRIVER_CHROME_CANDIDATES = ("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser")


def _nodriver_chrome() -> Optional[str]:
    explicit = os.getenv("SCRAPER_NODRIVER_CHROME", "").strip()
    if explicit:
        return explicit
    for path in _NODRIVER_CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    return None  # let nodriver auto-detect


def _nodriver_available() -> bool:
    if os.getenv("SCRAPER_NODRIVER", "1").strip().lower() in {"0", "false", "no", "off"}:
        return False
    try:
        import nodriver  # noqa: F401
    except Exception:
        return False
    return True


def _maybe_json(raw: Any) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw if isinstance(raw, str) else str(raw))
    except Exception:
        return None


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def _title_from_html(html: str) -> Optional[str]:
    m = _TITLE_RE.search(html or "")
    return m.group(1).strip()[:300] if m else None


async def _nodriver_capture(url: str, calls: list) -> tuple[str, str]:
    import nodriver as uc

    RT = uc.cdp.network.ResourceType
    headful = os.getenv("SCRAPER_NODRIVER_HEADFUL", "").strip().lower() in {"1", "true", "yes"}
    args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    browser = await uc.start(headless=not headful, browser_executable_path=_nodriver_chrome(), sandbox=False, browser_args=args)
    reqs: dict = {}

    async def on_req(evt):
        try:
            r = evt.request
            if url_allowed(str(r.url)):
                reqs[evt.request_id] = (str(r.method).upper(), str(r.url), dict(getattr(r, "headers", {}) or {}), getattr(r, "post_data", None))
        except Exception:
            pass

    async def on_resp(evt):
        try:
            if evt.type_ not in (RT.XHR, RT.FETCH):
                return
            meth, u, hdrs, post = reqs.get(evt.request_id, ("GET", str(evt.response.url), {}, None))
            if not url_allowed(u):
                return
            calls.append(
                RawNetworkCall(
                    method=meth,
                    raw_url=u,
                    request_headers=hdrs,
                    status_code=int(evt.response.status),
                    content_type=str(getattr(evt.response, "mime_type", "") or ""),
                    request_body=_maybe_json(post),
                    response_body=None,
                )
            )
        except Exception:
            pass

    try:
        tab = await browser.get("about:blank")
        tab.add_handler(uc.cdp.network.RequestWillBeSent, on_req)
        tab.add_handler(uc.cdp.network.ResponseReceived, on_resp)
        await tab.send(uc.cdp.network.enable())
        await tab.get(url)
        await asyncio.sleep(_NODRIVER_WAIT_S)
        # Bounded interaction (same intent as the Scrapling tiers' page_action) to surface action-only XHR.
        if _interaction_enabled():
            for _ in range(_INTERACT_SCROLLS):
                try:
                    await tab.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                except Exception:
                    break
                await asyncio.sleep(1.0)
            try:
                await tab.evaluate(
                    "(function(){var i=document.querySelector(\"input[type=search],input[name*='q'],input[name*='search']\");"
                    "if(i){i.value='test';if(i.form&&i.form.requestSubmit){i.form.requestSubmit();}"
                    "else{i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}}})()"
                )
                await asyncio.sleep(1.2)
            except Exception:
                pass
            # Restore the requested document if a search submit navigated away (keeps DOM + relative-link base
            # aligned with the URL the bundle records). The traffic fired during interaction is already captured.
            try:
                landed = str(await tab.evaluate("location.href"))
                if _strip_fragment(landed) != _strip_fragment(url):
                    await tab.get(url)
                    await asyncio.sleep(1.0)
            except Exception:
                pass
        html = await tab.get_content()
        final_url = url
        try:
            final_url = str(await tab.evaluate("location.href")) or url
        except Exception:
            pass
        return str(html or ""), final_url
    finally:
        try:
            browser.stop()
        except Exception:
            pass


class Tier4Fetcher:
    """nodriver + CDP, real Chrome, max stealth + full CDP network capture (XHR/fetch with method/headers/body)."""

    tier = 4

    def fetch(self, url: str) -> Optional[FetchResult]:
        if not _nodriver_available() or not url_allowed(url):
            return None
        calls: list = []
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            html, final_url = loop.run_until_complete(_nodriver_capture(url, calls))
        except Exception:
            return None
        finally:
            try:
                loop.close()
            except Exception:
                pass
            asyncio.set_event_loop(None)
        if not html or not url_allowed(final_url):
            return None
        return FetchResult(
            html=html,
            status=200,
            rendered_with_js=True,
            network=calls,
            selectors_of_interest=[],
            title=_title_from_html(html),
        )


def _title(resp: Any) -> Optional[str]:
    try:
        found = resp.css("title::text")
        return str(found[0]) if found else None
    except Exception:
        return None
