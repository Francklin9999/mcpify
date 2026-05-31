"""robots gate (safe mode) - tested with an injected fetch, no live internet."""

from scraper.robots import robots_allows


def test_disallowed_path_is_blocked():
    robots = "User-agent: *\nDisallow: /private/\n"
    assert robots_allows("https://e.com/private/x", fetch=lambda _: robots) is False
    assert robots_allows("https://e.com/public/x", fetch=lambda _: robots) is True


def test_missing_robots_defaults_to_allow():
    # No robots.txt (fetch returns None) -> allowed, standard semantics.
    assert robots_allows("https://e.com/anything", fetch=lambda _: None) is True


def test_disallow_all():
    robots = "User-agent: *\nDisallow: /\n"
    assert robots_allows("https://e.com/", fetch=lambda _: robots) is False
