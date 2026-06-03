"""Shared SSRF URL guard for scraper request boundaries and fetch results."""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse


def host_is_internal(host: str) -> bool:
    """True if `host` is (or resolves to) a non-public address. Unresolvable hosts fail closed."""
    candidates: list = []
    try:
        candidates.append(ipaddress.ip_address(host))
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
        except OSError:
            return True
        for info in infos:
            addr = str(info[4][0]).split("%")[0]
            try:
                candidates.append(ipaddress.ip_address(addr))
            except ValueError:
                continue
    if not candidates:
        return True
    return any(
        ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        for ip in candidates
    )


def url_allowed(url: str) -> bool:
    """Only allow http(s) URLs whose host resolves to public addresses, unless explicitly disabled."""
    if os.getenv("SCRAPER_ALLOW_PRIVATE_HOSTS") == "1":
        return True
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    return not host_is_internal(parsed.hostname)
