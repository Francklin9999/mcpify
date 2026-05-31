"""mcp-scraper: Scrapling 3-tier fetcher -> CaptureBundle. See docs/services/scraper.md."""

from .capture import EscalationController, FetchResult, RawNetworkCall, assemble_bundle, template_url
from .contracts import CaptureBundle, ElementRef, NetworkCapture
from .legal import scrub_headers
from .robots import robots_allows

__all__ = [
    "EscalationController",
    "FetchResult",
    "RawNetworkCall",
    "assemble_bundle",
    "template_url",
    "CaptureBundle",
    "ElementRef",
    "NetworkCapture",
    "scrub_headers",
    "robots_allows",
]
