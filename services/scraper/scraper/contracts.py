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

from pydantic import BaseModel, ConfigDict, field_validator

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
    tier: Optional[Literal[1, 2, 3]] = None
    dom: DomSnapshot
    network: list[NetworkCapture]
    meta: CaptureMeta

    _v_bundle_id = field_validator("bundleId")(staticmethod(_require_uuid))
    _v_url = field_validator("url")(staticmethod(_require_url))
    _v_captured_at = field_validator("capturedAt")(staticmethod(_require_iso_datetime))
