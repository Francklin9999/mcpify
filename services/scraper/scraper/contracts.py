"""Pydantic mirror of the CaptureBundle contract (docs/01-contracts.md S1).

The canonical schema is @mcp/types (zod); this mirror is kept in lockstep and proven against the SAME
repo-root golden fixtures the TS tests load (tests/test_contracts.py). Hand-maintained per the v1
cross-language strategy (01 SCross-language) with a golden round-trip as the drift guard.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime
from typing import Any, Literal, Optional
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .legal import is_secret_field, is_secret_header

JsonSchema = dict[str, Any]
LegalMode = Literal["safe", "full_scrape", "session"]


# Validators that match the @mcp/types zod constraints WITHOUT mutating the value (so the exact string
# round-trips). These make "pydantic accepts" a faithful proxy for "the TS contract accepts".
def _require_url(v: str) -> str:
    parsed = urlparse(v)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"must be a valid URL (zod .url()): {v!r}")
    return v


def _require_uuid(v: str) -> str:
    _uuid.UUID(v)  # raises ValueError on a non-uuid
    return v


def _require_iso_datetime(v: str) -> str:
    datetime.fromisoformat(v)  # accepts offset-aware ISO-8601 (zod IsoDateTime)
    return v


class ElementRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str
    selector: str
    fallbackSelectors: Optional[list[str]] = None


class PageField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str
    label: Optional[str] = None
    placeholder: Optional[str] = None
    required: bool
    selector: Optional[str] = None


class PageForm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selector: str
    method: Literal["GET", "POST"]
    action: Optional[str] = None
    purpose: Literal["search", "auth", "form", "filter"]
    submitLabel: Optional[str] = None
    submitSelector: Optional[str] = None
    fields: list[PageField]

    _v_action = field_validator("action")(staticmethod(_require_url))


class PageAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["link", "button", "input", "select", "menuitem"]
    label: str
    selector: str
    href: Optional[str] = None

    _v_href = field_validator("href")(staticmethod(_require_url))


class AppStateSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    source: str
    keys: Optional[list[str]] = None
    schema_: Optional[JsonSchema] = Field(default=None, alias="schema")
    types: Optional[list[str]] = None


class PageSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visibleText: Optional[str] = None
    headings: Optional[list[str]] = None
    actions: Optional[list[PageAction]] = None
    forms: Optional[list[PageForm]] = None
    appState: Optional[list[AppStateSummary]] = None


class NetworkCapture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: str
    urlPattern: str
    rawUrl: str
    requestHeaders: dict[str, str]
    requestBodySchema: Optional[JsonSchema] = None
    responseSchema: Optional[JsonSchema] = None
    statusCode: int
    contentType: str

    _v_raw_url = field_validator("rawUrl")(staticmethod(_require_url))

    @field_validator("requestHeaders")
    @classmethod
    def _reject_secret_headers(cls, headers: dict[str, str]) -> dict[str, str]:
        # FAIL-CLOSED legal backstop (04) - mirrors @mcp/types NetworkCapture.superRefine. A producer that
        # forgets to scrub fails validation here rather than leaking a secret downstream.
        for key in headers:
            if is_secret_header(key) or is_secret_field(key):
                raise ValueError(f"secret-list header must be scrubbed before persistence/transmission (04): {key}")
        return headers


class DomSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    html: str
    domHash: str
    selectorsOfInterest: Optional[list[ElementRef]] = None


class CaptureMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = None
    robotsAllowed: Optional[bool] = None
    renderedWithJs: bool


class CaptureBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bundleId: str
    source: Literal["scraper", "extension"]
    url: str
    capturedAt: str
    legalMode: LegalMode
    tier: Optional[Literal[1, 2, 3, 4]] = None
    dom: DomSnapshot
    network: list[NetworkCapture]
    page: Optional[PageSnapshot] = None
    meta: CaptureMeta

    _v_bundle_id = field_validator("bundleId")(staticmethod(_require_uuid))
    _v_url = field_validator("url")(staticmethod(_require_url))
    _v_captured_at = field_validator("capturedAt")(staticmethod(_require_iso_datetime))
