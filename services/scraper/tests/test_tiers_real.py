"""Real-fetcher proofs against a LOCAL server (no live internet).

Tier 1 always runs (no browser). Tier 2 is the high-signal proof - it requires a real Chromium; if the
browser can't launch in this environment the test is SKIPPED with a loud reason (network capture is then
UNVERIFIED - see README). It is never silently passed.
"""

import pytest

from scraper.capture import EscalationController, assemble_bundle
from scraper.tiers import Tier1Fetcher, Tier2Fetcher
from tests.local_server import LocalServer


def test_tier1_fetches_static_page():
    with LocalServer() as srv:
        result = Tier1Fetcher().fetch(f"{srv.base}/static")
    assert result is not None
    assert "hello static" in result.html
    assert result.rendered_with_js is False
    assert result.network == []  # static HTTP captures no XHR
    assert result.title == "Static"


def _browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, timeout=5000)
            b.close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _browser_available(), reason="Chromium cannot launch here - tier-2 capture UNVERIFIED")
def test_tier2_captures_load_time_xhr():
    """THE proof: the scraper's reason to exist - capture a real load-time XHR as a NetworkCapture."""
    with LocalServer() as srv:
        result = Tier2Fetcher().fetch(f"{srv.base}/spa")
    assert result is not None
    assert result.rendered_with_js is True

    # The SPA fires GET /api/items/1 at load - it must appear in the captured network.
    item_calls = [c for c in result.network if "/api/items/" in c.raw_url]
    assert item_calls, f"no /api/items XHR captured; saw {[c.raw_url for c in result.network]}"
    call = item_calls[0]
    assert call.method == "GET"

    # And it must survive into a contract-valid bundle with the templated pattern + inferred schema.
    bundle = assemble_bundle(f"{srv.base}/spa", "safe", 2, result)
    caps = [c for c in bundle.network if "/api/items/" in c.rawUrl]
    assert caps[0].urlPattern == "/api/items/{id}"
    assert caps[0].responseSchema == {"type": "object", "properties": {"id": {"type": "integer"}}}


@pytest.mark.skipif(not _browser_available(), reason="Chromium cannot launch here - escalation capture UNVERIFIED")
def test_escalation_reaches_tier2_for_a_200_spa_shell():
    """The INTEGRATED path (the real /capture entry): a tier-1 200 SPA shell must NOT short-circuit -
    escalation has to reach tier 2 so the XHR is captured. (Guards the escalation-success-predicate bug.)"""
    ctrl = EscalationController([Tier1Fetcher(), Tier2Fetcher()])
    with LocalServer() as srv:
        bundle = ctrl.capture(f"{srv.base}/spa", "safe")
    assert bundle.tier == 2, f"escalation stopped at tier {bundle.tier} - tier 2 never ran"
    assert any("/api/items/" in c.rawUrl for c in bundle.network), "integrated path captured no network"


def test_escalation_stops_at_tier1_for_a_static_page():
    """Counterpart: with discovery OFF, a genuinely static (no-script) page is sufficient at tier 1 - don't
    waste a browser. (Discovery mode, the default, intentionally escalates to a browser tier to capture XHR.)"""
    ctrl = EscalationController([Tier1Fetcher(), Tier2Fetcher()])
    with LocalServer() as srv:
        bundle = ctrl.capture(f"{srv.base}/static", "safe", discovery=False)
    assert bundle.tier == 1
    assert bundle.network == []
