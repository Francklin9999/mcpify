"""Interaction-driven capture: the bounded post-load pass (scroll / search-submit / load-more) that surfaces
XHR which only fires on user action.

The action logic is proven OFFLINE with a fake page (deterministic, no browser). The end-to-end proof - that
those interactions actually land action-only endpoints in the captured network - is browser-gated and SKIPPED
(loudly) where Chromium can't launch, mirroring test_tiers_real.py.
"""

import pytest

from scraper.tiers import _make_interaction_action


class _El:
    def __init__(self, page, name):
        self.page = page
        self.name = name

    def fill(self, value):
        self.page.log.append(("fill", self.name, value))

    def press(self, key):
        self.page.log.append(("press", self.name, key))
        # A search submit (Enter) navigates to the results page on many sites.
        if self.name == "search" and self.page._nav_on_submit:
            self.page.url = self.page._start_url + "search?q=test"

    def click(self, **kwargs):
        self.page.log.append(("click", self.name))
        # An <a> "Next" click is a full navigation to another document.
        if self.name == "more" and self.page._nav_on_click:
            self.page.url = self.page._start_url + "page-2.html"


class _FakePage:
    """Records the interactions the action performs; can simulate a missing element, a throwing evaluate, or
    an interaction that NAVIGATES the page to a different document (search submit / <a> Next)."""

    def __init__(self, search=True, more=True, raise_eval=False, nav_on_click=False, nav_on_submit=False, start_url="https://site.test/catalogue/"):
        self.log = []
        self._search = search
        self._more = more
        self._raise_eval = raise_eval
        self._nav_on_click = nav_on_click
        self._nav_on_submit = nav_on_submit
        self._start_url = start_url
        self.url = start_url

    def evaluate(self, js):
        if self._raise_eval:
            raise RuntimeError("evaluate blew up")
        self.log.append(("evaluate", js))

    def goto(self, url, **kwargs):
        self.log.append(("goto", url))
        self.url = url

    def wait_for_load_state(self, *args, **kwargs):
        self.log.append(("idle",))

    def wait_for_timeout(self, *args, **kwargs):
        self.log.append(("timeout",))

    def query_selector(self, selector):
        if "Load more" in selector or "rel=next" in selector:
            return _El(self, "more") if self._more else None
        return _El(self, "search") if self._search else None


def test_interaction_action_scrolls_searches_and_loads_more():
    page = _FakePage()
    result = _make_interaction_action()(page)
    assert result is page, "page_action must return the page (Scrapling uses the return value)"
    assert any(e[0] == "evaluate" and "scrollTo" in e[1] for e in page.log), "should scroll to trigger lazy XHR"
    assert ("fill", "search", "test") in page.log, "should fill the search box"
    assert ("press", "search", "Enter") in page.log, "should submit the search"
    assert ("click", "more") in page.log, "should click a load-more / next control"


def test_interaction_action_is_fail_soft_when_a_step_throws():
    page = _FakePage(raise_eval=True)
    # Must not raise even though evaluate() throws on the first scroll.
    result = _make_interaction_action()(page)
    assert result is page


def test_interaction_action_handles_missing_controls():
    page = _FakePage(search=False, more=False)
    result = _make_interaction_action()(page)
    assert result is page
    assert not any(e[0] in ("fill", "press", "click") for e in page.log), "no search/more controls -> no clicks"


def test_interaction_restores_original_document_after_a_navigating_click():
    # An <a> "Next" click navigates to /catalogue/page-2.html. The pass must navigate BACK to the start URL so
    # the analyzed DOM (and its relative-link base) stays the requested page - otherwise links resolve against
    # the wrong base and drop the "/catalogue/" prefix (the books.toscrape bug).
    page = _FakePage(nav_on_click=True)
    _make_interaction_action()(page)
    assert page.url == "https://site.test/catalogue/", "page must be restored to the requested document"
    assert ("goto", "https://site.test/catalogue/") in page.log, "should navigate back after a navigating click"


def test_interaction_restores_original_document_after_a_navigating_search():
    page = _FakePage(nav_on_submit=True, more=False)
    _make_interaction_action()(page)
    assert page.url == "https://site.test/catalogue/", "a navigating search submit must also be restored"


def test_interaction_does_not_renavigate_when_no_navigation_occurred():
    # Pure in-page interactions (scroll, AJAX load-more): no full navigation -> no wasteful goto back.
    page = _FakePage(nav_on_click=False, nav_on_submit=False)
    _make_interaction_action()(page)
    assert not any(e[0] == "goto" for e in page.log), "must not re-navigate when the document never changed"


def test_interaction_action_is_disabled_by_env(monkeypatch):
    monkeypatch.setenv("SCRAPER_INTERACT", "0")
    page = _FakePage()
    result = _make_interaction_action()(page)
    assert result is page
    assert page.log == [], "SCRAPER_INTERACT=0 disables the interaction pass entirely"


def _browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, timeout=5000)
            b.close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _browser_available(), reason="Chromium cannot launch here - interaction capture UNVERIFIED")
def test_interaction_captures_action_only_xhr():
    """THE proof: /scroll-search fires NO XHR on load; only the interaction pass surfaces /api/search + /api/loadmore."""
    from scraper.tiers import Tier2Fetcher
    from tests.local_server import LocalServer

    with LocalServer() as srv:
        result = Tier2Fetcher().fetch(f"{srv.base}/scroll-search")
    assert result is not None
    urls = [c.raw_url for c in result.network]
    assert any("/api/search" in u for u in urls), f"search-submit XHR not captured; saw {urls}"
    assert any("/api/loadmore" in u for u in urls), f"load-more click XHR not captured; saw {urls}"
