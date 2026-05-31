"""Secret-list scrub parity: the Python scrub matches the shared golden fixture (same as the TS test)."""

from scraper.legal import is_secret_field, scrub_headers


def test_scrub_matches_golden_fixture(repo_fixture):
    fx = repo_fixture("secret-scrub/headers.json")
    scrubbed = scrub_headers(fx["input"])
    assert sorted(scrubbed.keys()) == sorted(fx["expectedKeptKeys"])


def test_field_pattern_catches_token_anywhere():
    # `*token*` / `*session*` glob — case-insensitive, substring (a field pattern, not a literal header).
    assert is_secret_field("X-Session-Token")
    assert scrub_headers({"x-session-token": "t", "accept": "json"}) == {"accept": "json"}
