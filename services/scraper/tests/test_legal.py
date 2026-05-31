"""Secret-list scrub parity: the Python scrub matches the shared golden fixture (same as the TS test)."""

import json

from scraper.legal import _secret_list, is_secret_field, scrub_headers


def test_scrub_matches_golden_fixture(repo_fixture):
    fx = repo_fixture("secret-scrub/headers.json")
    scrubbed = scrub_headers(fx["input"])
    assert sorted(scrubbed.keys()) == sorted(fx["expectedKeptKeys"])


def test_field_pattern_catches_token_anywhere():
    # `*token*` / `*session*` glob — case-insensitive, substring (a field pattern, not a literal header).
    assert is_secret_field("X-Session-Token")
    assert scrub_headers({"x-session-token": "t", "accept": "json"}) == {"accept": "json"}


def test_secret_list_path_can_be_overridden(monkeypatch, tmp_path):
    secret_list = tmp_path / "secret-list.json"
    secret_list.write_text(json.dumps({"headers": ["x-api-key"], "fieldPatterns": ["*secret*"]}))
    monkeypatch.setenv("MCP_SECRET_LIST_PATH", str(secret_list))
    _secret_list.cache_clear()
    try:
        assert scrub_headers({"x-api-key": "drop", "x-safe": "keep"}) == {"x-safe": "keep"}
        assert is_secret_field("client_secret")
    finally:
        _secret_list.cache_clear()
