"""Pure capture core: normalization, escalation, URL templating, schema inference, bundle assembly.

No Scrapling / browser imports here - the tier fetchers (tiers.py) live behind the `Fetcher` protocol so
this whole module is testable with fakes (docs/services/scraper.md "test in isolation").
"""

from __future__ import annotations

import hashlib
import html as html_lib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Optional, Protocol
from urllib.parse import parse_qsl, urljoin, urlparse

from .contracts import (
    CaptureBundle,
    CaptureMeta,
    DomSnapshot,
    ElementRef,
    AppStateSummary,
    LegalMode,
    NetworkCapture,
    PageAction,
    PageField,
    PageForm,
    PageSnapshot,
)
from .legal import scrub_headers


@dataclass
class RawNetworkCall:
    method: str
    raw_url: str
    request_headers: dict[str, str]
    status_code: int
    content_type: str
    request_body: Any = None  # parsed JSON/body shape, if any
    response_body: Any = None  # parsed JSON, if any


@dataclass
class FetchResult:
    """Tier-agnostic fetch output. Each tier normalizes its Scrapling Response into this."""

    html: str
    status: int
    rendered_with_js: bool
    network: list[RawNetworkCall] = field(default_factory=list)
    selectors_of_interest: list[ElementRef] = field(default_factory=list)
    page: Optional[PageSnapshot] = None
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
    """Shallow JSON-Schema-ish inference (1 nested level). Schemas only - never raw values (04)."""
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
        method=call.method.upper(),
        urlPattern=template_url(call.raw_url),
        rawUrl=call.raw_url,
        requestHeaders=scrub_headers(call.request_headers),  # FAIL-CLOSED before construction (04)
        requestBodySchema=infer_schema(call.request_body) if call.request_body is not None else None,
        responseSchema=infer_schema(call.response_body) if call.response_body is not None else None,
        statusCode=call.status_code,
        contentType=call.content_type,
    )


def _query_key_signature(raw_url: str) -> tuple[str, ...]:
    try:
        parsed = urlparse(raw_url)
        return tuple(sorted({key for key, _value in parse_qsl(parsed.query, keep_blank_values=True)}))
    except Exception:
        return ()


def _network_call_score(call: RawNetworkCall) -> tuple[int, int, int, int]:
    ok_status = 1 if 200 <= call.status_code < 300 else 0
    has_request_body = 1 if call.request_body is not None else 0
    has_response_body = 1 if call.response_body is not None else 0
    json_type = 1 if "json" in (call.content_type or "").lower() else 0
    return (ok_status, has_request_body, has_response_body, json_type)


def dedupe_network_calls(calls: list[RawNetworkCall]) -> list[RawNetworkCall]:
    """Collapse repeated browser XHR/fetch observations before contract assembly.

    Browser pages often poll or request the same endpoint for many rows. Keeping every observation bloats the
    bundle and causes repeated equivalent tool candidates downstream. The key keeps the path template and
    query-key set, while the winner prefers successful JSON calls carrying request/response schemas.
    """
    best: dict[tuple[str, str, tuple[str, ...]], RawNetworkCall] = {}
    order: list[tuple[str, str, tuple[str, ...]]] = []
    for call in calls:
        key = (call.method.upper(), template_url(call.raw_url), _query_key_signature(call.raw_url))
        current = best.get(key)
        if current is None:
            best[key] = call
            order.append(key)
            continue
        if _network_call_score(call) > _network_call_score(current):
            best[key] = call
    return [best[key] for key in order]


_SEARCH_FIELD_NAMES = {
    "q",
    "query",
    "search",
    "s",
    "keyword",
    "keywords",
    "term",
    "searchterm",
    "find_desc",
    "k",
    "_nkw",
    "search_term_string",
    "text",
}
_FIELD_SKIP_TYPES = {"hidden", "submit", "button", "image", "reset", "file"}
_MAX_APP_STATE_CHARS = 1_000_000
_APP_STATE_IDS = {"__NEXT_DATA__", "__NUXT_DATA__", "__APOLLO_STATE__"}


def _clean_text(value: str, max_len: int = 240) -> str:
    text = re.sub(r"\s+", " ", html_lib.unescape(value)).strip()
    return text[: max_len - 3] + "..." if len(text) > max_len else text


def _attr_map(attrs: list[tuple[str, Optional[str]]]) -> dict[str, str]:
    return {key.lower(): html_lib.unescape(value or "") for key, value in attrs}


def _css_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _selector(tag: str, attrs: dict[str, str]) -> str:
    if attrs.get("id"):
        return f"#{attrs['id']}"
    if attrs.get("name"):
        return f'{tag}[name="{_css_string(attrs["name"])}"]'
    if tag == "form" and attrs.get("action"):
        return f'form[action="{_css_string(attrs["action"])}"]'
    if tag == "a" and attrs.get("href"):
        return f'a[href="{_css_string(attrs["href"])}"]'
    if attrs.get("type"):
        return f'{tag}[type="{_css_string(attrs["type"])}"]'
    return tag


def _absolute_url(raw: str, base_url: str) -> Optional[str]:
    if not raw or re.match(r"^(?:javascript|mailto|tel):", raw, re.I):
        return None
    try:
        resolved = urljoin(base_url, raw)
        parsed = urlparse(resolved)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        return resolved
    except Exception:
        return None


def _json_types(value: Any, out: set[str], depth: int = 0) -> None:
    if depth > 5:
        return
    if isinstance(value, dict):
        type_value = value.get("@type") or value.get("type") or value.get("__typename")
        if isinstance(type_value, str) and re.match(r"^[A-Za-z][A-Za-z0-9_.:-]{1,80}$", type_value):
            out.add(type_value)
        for nested in list(value.values())[:40]:
            _json_types(nested, out, depth + 1)
    elif isinstance(value, list):
        for item in value[:40]:
            _json_types(item, out, depth + 1)


def _app_state_summary(source: str, value: Any) -> AppStateSummary:
    keys = list(value.keys())[:40] if isinstance(value, dict) else None
    types: set[str] = set()
    _json_types(value, types)
    return AppStateSummary(
        source=source,
        keys=keys or None,
        schema=infer_schema(value),
        types=sorted(types)[:40] or None,
    )


def _attrs_from_tag(source: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for match in re.finditer(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?""", source):
        out[match.group(1).lower()] = html_lib.unescape(match.group(2) or match.group(3) or match.group(4) or "")
    return out


def app_state_hints(html: str) -> list[AppStateSummary]:
    hints: list[AppStateSummary] = []
    seen: set[str] = set()
    for match in re.finditer(r"<script\b([^>]*)>([\s\S]*?)</script>", html, re.I):
        if len(hints) >= 8:
            break
        attrs = _attrs_from_tag(match.group(1) or "")
        script_id = attrs.get("id")
        script_type = attrs.get("type", "")
        if script_id not in _APP_STATE_IDS and "application/json" not in script_type.lower():
            continue
        raw = (match.group(2) or "").strip()
        if not raw or len(raw) > _MAX_APP_STATE_CHARS:
            continue
        source = script_id or script_type or "application/json"
        if source in seen:
            continue
        try:
            hints.append(_app_state_summary(source, json.loads(html_lib.unescape(raw))))
            seen.add(source)
        except Exception:
            continue
    for source, pattern in (
        ("window.__INITIAL_STATE__", r"window\.__INITIAL_STATE__\s*=\s*({[\s\S]{1,1000000}?})\s*;"),
        ("window.__PRELOADED_STATE__", r"window\.__PRELOADED_STATE__\s*=\s*({[\s\S]{1,1000000}?})\s*;"),
    ):
        if len(hints) >= 8 or source in seen:
            continue
        match = re.search(pattern, html)
        if not match:
            continue
        try:
            hints.append(_app_state_summary(source, json.loads(match.group(1))))
            seen.add(source)
        except Exception:
            continue
    return hints


class _SnapshotParser(HTMLParser):
    def __init__(self, page_url: str):
        super().__init__(convert_charrefs=False)
        self.page_url = page_url
        self.skip_depth = 0
        self.visible_chunks: list[str] = []
        self.headings: list[str] = []
        self._heading: Optional[list[str]] = None
        self._forms: list[dict[str, Any]] = []
        self._current_form: Optional[dict[str, Any]] = None
        self._actions: list[PageAction] = []
        self._action_stack: list[dict[str, Any]] = []

    def handle_starttag(self, tag: str, attrs_raw: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        attrs = _attr_map(attrs_raw)
        if tag in {"script", "style", "svg", "noscript"}:
            self.skip_depth += 1
            return
        if tag in {"h1", "h2", "h3"}:
            self._heading = []
        if tag == "form" and len(self._forms) < 12:
            action = _absolute_url(attrs.get("action") or self.page_url, self.page_url)
            self._current_form = {
                "selector": _selector("form", attrs),
                "method": "POST" if attrs.get("method", "").lower() == "post" else "GET",
                "action": action,
                "fields": [],
                "has_password": False,
                "submitLabel": None,
                "submitSelector": None,
            }
        if self._current_form is not None and tag in {"input", "select", "textarea"}:
            self._capture_field(tag, attrs)
        if tag in {"a", "button"}:
            href = _absolute_url(attrs.get("href", ""), self.page_url) if tag == "a" else None
            if tag == "button" or href:
                self._action_stack.append({"tag": tag, "attrs": attrs, "href": href, "text": []})

    def handle_startendtag(self, tag: str, attrs_raw: list[tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs_raw)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "svg", "noscript"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in {"h1", "h2", "h3"} and self._heading is not None:
            text = _clean_text(" ".join(self._heading), 160)
            if text and len(self.headings) < 24:
                self.headings.append(text)
            self._heading = None
        if tag == "form" and self._current_form is not None:
            form = self._finalize_form(self._current_form)
            if form is not None:
                self._forms.append(form)
            self._current_form = None
        if tag in {"a", "button"} and self._action_stack:
            entry = self._action_stack.pop()
            if entry.get("tag") == tag:
                self._add_action_from_entry(entry)

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        if self._heading is not None:
            self._heading.append(data)
        for entry in self._action_stack:
            entry["text"].append(data)
        if len(" ".join(self.visible_chunks)) < 12000:
            self.visible_chunks.append(data)

    def _capture_field(self, tag: str, attrs: dict[str, str]) -> None:
        if self._current_form is None:
            return
        field_type = (attrs.get("type") if tag == "input" else tag) or "text"
        field_type = field_type.lower()
        if field_type == "password":
            self._current_form["has_password"] = True
        if field_type in {"submit", "button", "image"}:
            label = _clean_text(attrs.get("value", ""), 120)
            if label:
                self._current_form["submitLabel"] = label
                self._current_form["submitSelector"] = _selector(tag, attrs)
            self._add_immediate_action("button", label, _selector(tag, attrs), None)
            return
        if field_type in _FIELD_SKIP_TYPES:
            return
        name = attrs.get("name")
        if not name or len(self._current_form["fields"]) >= 16:
            return
        lower_name = name.lower()
        required = "required" in attrs or lower_name in _SEARCH_FIELD_NAMES or field_type == "search"
        self._current_form["fields"].append(
            PageField(
                name=name,
                type=field_type,
                placeholder=attrs.get("placeholder") or None,
                required=required,
                selector=_selector(tag, attrs),
            )
        )

    def _finalize_form(self, form: dict[str, Any]) -> Optional[PageForm]:
        fields = form["fields"]
        if not fields:
            return None
        if form["has_password"]:
            purpose = "auth"
        elif any(field.required and field.name.lower() in _SEARCH_FIELD_NAMES for field in fields) or any(field.type == "search" for field in fields):
            purpose = "search"
        elif any(re.search(r"filter|facet|category|sort", field.name, re.I) for field in fields):
            purpose = "filter"
        else:
            purpose = "form"
        return PageForm(
            selector=form["selector"],
            method=form["method"],
            action=form["action"],
            purpose=purpose,
            submitLabel=form["submitLabel"],
            submitSelector=form["submitSelector"],
            fields=fields,
        )

    def _add_immediate_action(self, kind: str, label: str, selector: str, href: Optional[str]) -> None:
        if not label or len(self._actions) >= 80:
            return
        try:
            self._actions.append(PageAction(kind=kind, label=label, selector=selector, href=href))
        except Exception:
            pass

    def _add_action_from_entry(self, entry: dict[str, Any]) -> None:
        tag = entry["tag"]
        label = _clean_text(" ".join(entry["text"]), 120)
        if not label:
            return
        kind = "link" if tag == "a" else "button"
        self._add_immediate_action(kind, label, _selector(tag, entry["attrs"]), entry.get("href"))

    def snapshot(self) -> PageSnapshot:
        visible = _clean_text(" ".join(self.visible_chunks), 8000)
        return PageSnapshot(
            visibleText=visible or None,
            headings=self.headings[:24] or None,
            actions=self._actions[:80] or None,
            forms=self._forms[:12] or None,
        )


def snapshot_page(html: str, page_url: str) -> PageSnapshot:
    parser = _SnapshotParser(page_url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        return PageSnapshot()
    snapshot = parser.snapshot()
    hints = app_state_hints(html)
    if hints:
        snapshot.appState = hints
    return snapshot


def dom_hash(html: str) -> str:
    return "sha256:" + hashlib.sha256(html.encode("utf-8")).hexdigest()


def assemble_bundle(url: str, legal_mode: LegalMode, tier: int, result: FetchResult) -> CaptureBundle:
    page = result.page or snapshot_page(result.html, url)
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
        network=[_to_network_capture(c) for c in dedupe_network_calls(result.network)],
        page=page,
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
    """A script-bearing page with little visible text - a JS shell whose real content/API calls only appear
    after the browser runs it. Tier 1 can't see those; escalate to a browser tier. (Tunable heuristic.)"""
    return "<script" in html.lower() and _visible_text_len(html) < _SHELL_TEXT_THRESHOLD


# Bot-wall / anti-bot challenge markers. A page can return HTTP 200 yet be a captcha/challenge (Amazon,
# Cloudflare, PerimeterX, etc.) - so status alone won't catch it. Conservative set to avoid false positives.
_BOT_MARKERS = (
    "captcha",
    "enter the characters you see",
    "automated access",
    "api-services-support@amazon",
    "unusual traffic",
    "/cdn-cgi/challenge-platform",
    "just a moment...",
    "verify you are a human",
    "human verification",
    "client challenge",
    "checking your browser",
    "enable javascript and cookies",
    "are you a robot",
    "px-captcha",
    "access to this page has been denied",
)


def looks_like_bot_wall(html: str, title: Optional[str] = None) -> bool:
    """True if the page looks like an anti-bot challenge rather than real content. Conservative - used to
    escalate a plain-HTTP (tier-1) hit to the stealthier browser tiers, which may pass the challenge."""
    hay = (html[:20000] + " " + (title or "")).lower()
    return any(m in hay for m in _BOT_MARKERS)


def is_sufficient(result: FetchResult) -> bool:
    """Whether a tier's result ends escalation. Tier 1 is the SSR fast path: it's sufficient only for
    genuinely static pages. A browser tier (rendered_with_js) or any captured network is always sufficient.
    A bot-wall (even with content/JS) is NEVER sufficient from a weaker tier - escalate to stealth."""
    if looks_like_bot_wall(result.html, result.title):
        return False  # try the next, stealthier tier; the controller keeps best-effort if all fail
    if result.network or result.rendered_with_js:
        return True
    return not looks_client_rendered(result.html)


class EscalationController:
    """Try tiers in order; stop at the first SUFFICIENT result. A tier-1 200 shell is NOT sufficient -
    escalate to a browser tier so XHR/network gets captured (docs S3-tier). Bounded, never loops."""

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
        # unavailable) rather than nothing - the generator assesses low confidence. None at all -> empty.
        if best is not None:
            return assemble_bundle(url, legal_mode, best[0], best[1])
        return empty_bundle(url, legal_mode, robots_allowed=True)
