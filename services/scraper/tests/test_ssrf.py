"""SSRF guard for the /capture boundary (service._url_allowed). Hermetic: uses literal IPs only (no DNS)."""

import pytest

from scraper.service import _host_is_internal, _url_allowed


@pytest.fixture(autouse=True)
def _guard_on(monkeypatch):
    # The suite-wide conftest sets SCRAPER_ALLOW_PRIVATE_HOSTS=1 for hermeticity; clear it here so the guard
    # actually runs in these tests.
    monkeypatch.delenv("SCRAPER_ALLOW_PRIVATE_HOSTS", raising=False)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",            # loopback
        "http://localhost/",            # loopback name (resolves to 127.0.0.1/::1)
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.0.0.5/",             # RFC1918
        "http://192.168.1.1/",          # RFC1918
        "http://172.16.0.1/",           # RFC1918
        "http://[::1]/",                # IPv6 loopback
        "http://0.0.0.0/",              # unspecified
        "file:///etc/passwd",           # non-http scheme
        "ftp://example.com/",           # non-http scheme
        "gopher://127.0.0.1:6379/",     # non-http scheme (redis SSRF vector)
        "not a url",                    # garbage
        "http:///nohost",               # missing host
    ],
)
def test_blocks_internal_and_bad_schemes(url):
    assert _url_allowed(url) is False, f"should block {url}"


@pytest.mark.parametrize(
    "url",
    [
        "http://93.184.216.34/",        # literal public IP (example.com's), no DNS needed
        "https://1.1.1.1/",             # literal public IP
    ],
)
def test_allows_public(url):
    assert _url_allowed(url) is True, f"should allow {url}"


def test_opt_out_allows_everything(monkeypatch):
    monkeypatch.setenv("SCRAPER_ALLOW_PRIVATE_HOSTS", "1")
    assert _url_allowed("http://127.0.0.1/") is True


class _FakeResp:
    """Stand-in for a Scrapling response exposing the post-redirect URL via `.url`."""

    def __init__(self, final_url):
        self.url = final_url


def test_redirect_to_internal_is_rejected_post_fetch(monkeypatch):
    # The tiers re-check the FINAL response URL (after redirects) with url_allowed(_response_url(...)). A public
    # URL that 30x-redirects to an internal host must be rejected so its content is never returned (SSRF).
    monkeypatch.delenv("SCRAPER_ALLOW_PRIVATE_HOSTS", raising=False)
    from scraper.tiers import _response_url

    redirected = _response_url(_FakeResp("http://169.254.169.254/latest/meta-data/"), "https://public.example/")
    assert _url_allowed(redirected) is False

    stayed_public = _response_url(_FakeResp("http://93.184.216.34/landing"), "https://public.example/")
    assert _url_allowed(stayed_public) is True


def test_dns_resolution_to_private_address_is_blocked(monkeypatch):
    monkeypatch.setattr(
        "scraper.ssrf.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("169.254.169.254", 0))],
    )
    assert _host_is_internal("metadata.example.test") is True
    assert _url_allowed("https://metadata.example.test/") is False
