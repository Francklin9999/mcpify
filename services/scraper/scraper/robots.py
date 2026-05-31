"""robots.txt gate for `safe` mode (docs/04-legal-modes.md enforcement point).

`fetch_robots` is injectable so the gate is testable without live internet.
"""

from __future__ import annotations

from typing import Callable, Optional
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

# A polite default UA; the real fetcher passes its own.
USER_AGENT = "mcp-scraper"

RobotsFetcher = Callable[[str], Optional[str]]


def _default_fetch(robots_url: str) -> Optional[str]:
    import urllib.request

    try:
        with urllib.request.urlopen(robots_url, timeout=5) as resp:  # noqa: S310 - http(s) only by construction
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def robots_allows(url: str, *, fetch: RobotsFetcher = _default_fetch, user_agent: str = USER_AGENT) -> bool:
    """True if robots.txt permits fetching `url` for `user_agent`.

    If robots.txt is missing/unreachable, default to ALLOW (standard robots semantics: no rules = allowed).
    """
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return False
    robots_url = urljoin(f"{parsed.scheme}://{parsed.netloc}", "/robots.txt")
    body = fetch(robots_url)
    if body is None:
        return True
    rp = RobotFileParser()
    rp.parse(body.splitlines())
    return rp.can_fetch(user_agent, url)
