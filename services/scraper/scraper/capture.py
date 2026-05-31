"""Pure capture core: normalization, escalation, URL templating, schema inference, bundle assembly.

No Scrapling / browser imports here — the tier fetchers (tiers.py) live behind the `Fetcher` protocol so
this whole module is testable with fakes (docs/services/scraper.md "test in isolation").
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, Protocol

from .contracts import (
    CaptureBundle,
    CaptureMeta,
    DomSnapshot,
    ElementRef,
    LegalMode,
    NetworkCapture,
)
from .legal import scrub_headers


@dataclass
class RawNetworkCall:
    method: str
    raw_url: str
    request_headers: dict[str, str]
    status_code: int
    content_type: str
    response_body: Any = None  # parsed JSON, if any


@dataclass
class FetchResult:
    """Tier-agnostic fetch output. Each tier normalizes its Scrapling Response into this."""

    html: str
    status: int
    rendered_with_js: bool
    network: list[RawNetworkCall] = field(default_factory=list)
    selectors_of_interest: list[ElementRef] = field(default_factory=list)
    title: Optional[str] = None


class Fetcher(Protocol):
    tier: int

    def fetch(self, url: str) -> Optional[FetchResult]:
        """Return a FetchResult, or None if this tier failed (escalate to the next)."""
        ...


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX_RE = re.compile(r"^[0-9a-f]{16,}$", re.I)


def template_url(raw_url: str) -> str:
    """Replace id-like path segments with {id}: /api/items/42 -> /api/items/{id}. Deterministic, pure."""
    m = re.match(r"^[a-z]+://[^/]+", raw_url, re.I)
    origin = m.group(0) if m else ""
    rest = raw_url[len(origin):]
    path = rest.split("?", 1)[0]
    segments = path.split("/")
    out = []
    for seg in segments:
        if seg.isdigit() or _UUID_RE.match(seg) or _HEX_RE.match(seg):
            out.append("{id}")
        else:
            out.append(seg)
    return "/".join(out)


def infer_schema(value: Any, _depth: int = 0) -> dict[str, Any]:
    """Shallow JSON-Schema-ish inference (1 nested level). Schemas only — never raw values (04)."""
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if value is None:
        return {"type": "null"}
    if isinstance(value, list):
        return {"type": "array"}
    if isinstance(value, dict):
        if _depth >= 1:
            return {"type": "object"}
        return {"type": "object", "properties": {k: infer_schema(v, _depth + 1) for k, v in value.items()}}
    return {}


def _to_network_capture(call: RawNetworkCall) -> NetworkCapture:
    return NetworkCapture(
        method=call.method,
        urlPattern=template_url(call.raw_url),
        rawUrl=call.raw_url,
        requestHeaders=scrub_headers(call.request_headers),  # FAIL-CLOSED before construction (04)
        responseSchema=infer_schema(call.response_body) if call.response_body is not None else None,
        statusCode=call.status_code,
        contentType=call.content_type,
    )


def dom_hash(html: str) -> str:
    return "sha256:" + hashlib.sha256(html.encode("utf-8")).hexdigest()


def assemble_bundle(url: str, legal_mode: LegalMode, tier: int, result: FetchResult) -> CaptureBundle:
    return CaptureBundle(
        bundleId=str(uuid.uuid4()),
        source="scraper",
        url=url,
        capturedAt=datetime.now(timezone.utc).isoformat(),
        legalMode=legal_mode,
        tier=tier,  # type: ignore[arg-type]
        dom=DomSnapshot(
            html=result.html,
            domHash=dom_hash(result.html),
            selectorsOfInterest=result.selectors_of_interest or None,
        ),
        network=[_to_network_capture(c) for c in result.network],
        meta=CaptureMeta(
            title=result.title,
            robotsAllowed=True,
            renderedWithJs=result.rendered_with_js,
        ),
    )


def empty_bundle(url: str, legal_mode: LegalMode, *, robots_allowed: bool) -> CaptureBundle:
    """A content-free bundle: robots-disallowed (safe mode) or all tiers exhausted."""
    return CaptureBundle(
        bundleId=str(uuid.uuid4()),
        source="scraper",
        url=url,
        capturedAt=datetime.now(timezone.utc).isoformat(),
        legalMode=legal_mode,
        dom=DomSnapshot(html="", domHash=dom_hash("")),
        network=[],
        meta=CaptureMeta(robotsAllowed=robots_allowed, renderedWithJs=False),
    )


_SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b.*?</\1>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_SHELL_TEXT_THRESHOLD = 200  # visible non-whitespace chars below which a script-bearing page is a "shell"


def _visible_text_len(html: str) -> int:
    text = _TAG_RE.sub(" ", _SCRIPT_STYLE_RE.sub(" ", html))
    return len("".join(text.split()))


def looks_client_rendered(html: str) -> bool:
    """A script-bearing page with little visible text — a JS shell whose real content/API calls only appear
    after the browser runs it. Tier 1 can't see those; escalate to a browser tier. (Tunable heuristic.)"""
    return "<script" in html.lower() and _visible_text_len(html) < _SHELL_TEXT_THRESHOLD


# Bot-wall / anti-bot challenge markers. A page can return HTTP 200 yet be a captcha/challenge (Amazon,
# Cloudflare, PerimeterX, etc.) — so status alone won't catch it. Conservative set to avoid false positives.
_BOT_MARKERS = (
    "captcha",
    "enter the characters you see",
    "automated access",
    "api-services-support@amazon",
    "unusual traffic",
    "/cdn-cgi/challenge-platform",
    "just a moment...",
    "verify you are a human",
    "are you a robot",
    "px-captcha",
    "access to this page has been denied",
)


def looks_like_bot_wall(html: str, title: Optional[str] = None) -> bool:
    """True if the page looks like an anti-bot challenge rather than real content. Conservative — used to
    escalate a plain-HTTP (tier-1) hit to the stealthier browser tiers, which may pass the challenge."""
    hay = (html[:20000] + " " + (title or "")).lower()
    return any(m in hay for m in _BOT_MARKERS)


def is_sufficient(result: FetchResult) -> bool:
    """Whether a tier's result ends escalation. Tier 1 is the SSR fast path: it's sufficient only for
    genuinely static pages. A browser tier (rendered_with_js) or any captured network is always sufficient.
    A bot-wall (even with content/JS) is NEVER sufficient from a weaker tier — escalate to stealth."""
    if looks_like_bot_wall(result.html, result.title):
        return False  # try the next, stealthier tier; the controller keeps best-effort if all fail
    if result.network or result.rendered_with_js:
        return True
    return not looks_client_rendered(result.html)


class EscalationController:
    """Try tiers in order; stop at the first SUFFICIENT result. A tier-1 200 shell is NOT sufficient —
    escalate to a browser tier so XHR/network gets captured (docs §3-tier). Bounded, never loops."""

    def __init__(self, tiers: list[Fetcher]):
        self._tiers = tiers

    def capture(self, url: str, legal_mode: LegalMode) -> CaptureBundle:
        best: Optional[tuple[int, FetchResult]] = None
        for fetcher in self._tiers:
            try:
                result = fetcher.fetch(url)
            except Exception:
                result = None
            if result is None:
                continue
            if best is None:
                best = (fetcher.tier, result)  # keep first usable result as fallback
            if is_sufficient(result):
                return assemble_bundle(url, legal_mode, fetcher.tier, result)
        # No tier was "sufficient": return the best we got (e.g. a tier-1 shell when browsers are
        # unavailable) rather than nothing — the generator assesses low confidence. None at all -> empty.
        if best is not None:
            return assemble_bundle(url, legal_mode, best[0], best[1])
        return empty_bundle(url, legal_mode, robots_allowed=True)
