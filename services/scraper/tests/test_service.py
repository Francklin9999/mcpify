"""FastAPI /capture surface — legal-mode gating, with a fake controller (no browser)."""

from fastapi.testclient import TestClient

from scraper.capture import EscalationController, FetchResult
from scraper.service import create_app


class FakeTier:
    tier = 1

    def fetch(self, url):
        return FetchResult(html="<html>ok</html>", status=200, rendered_with_js=False, title="OK")


def _client():
    return TestClient(create_app(EscalationController([FakeTier()])))


def test_safe_capture_returns_a_bundle(monkeypatch):
    # robots allows by default in this fake net; patch to force-allow without live fetch.
    import scraper.service as svc

    monkeypatch.setattr(svc, "robots_allows", lambda url: True)
    r = _client().post("/capture", json={"url": "https://example.com/x", "legalMode": "safe"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "scraper"
    assert body["meta"]["title"] == "OK"
    assert body["tier"] == 1


def test_safe_mode_honors_robots_disallow(monkeypatch):
    import scraper.service as svc

    monkeypatch.setattr(svc, "robots_allows", lambda url: False)
    r = _client().post("/capture", json={"url": "https://example.com/private", "legalMode": "safe"})
    assert r.status_code == 200
    body = r.json()
    assert body["dom"]["html"] == ""
    assert body["meta"]["robotsAllowed"] is False


def test_session_mode_is_rejected_server_side():
    r = _client().post("/capture", json={"url": "https://example.com/x", "legalMode": "session"})
    assert r.status_code == 200
    assert r.json()["dom"]["html"] == ""  # scraper never acts in a user session


def test_full_scrape_without_ack_falls_back_to_safe(monkeypatch):
    import scraper.service as svc

    seen = {}

    def fake_robots(url):
        seen["checked"] = True
        return True

    monkeypatch.setattr(svc, "robots_allows", fake_robots)
    r = _client().post("/capture", json={"url": "https://example.com/x", "legalMode": "full_scrape"})
    assert r.status_code == 200
    # Falling back to safe means robots WAS consulted (full_scrape would skip it).
    assert seen.get("checked") is True
