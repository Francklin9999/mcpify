"""FastAPI surface: POST /capture -> CaptureBundle (docs/services/scraper.md, 03 Flow A).

The generator calls this (sync HTTP, v1). Legal gate (04): `safe` honors robots.txt; `full_scrape` is only
reachable with the acknowledgement flag (the web app gates it); `session` is extension-only and rejected.
"""

from __future__ import annotations

import hmac
import os
import asyncio
import threading
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .capture import EscalationController, empty_bundle
from .contracts import CaptureBundle, LegalMode
from .robots import robots_allows
from .ssrf import host_is_internal as _host_is_internal
from .ssrf import url_allowed as _url_allowed
from .tiers import Tier1Fetcher, Tier2Fetcher, Tier3Fetcher, Tier4Fetcher, _nodriver_available


__all__ = ["_host_is_internal", "_url_allowed", "create_app", "app"]


class CaptureRequest(BaseModel):
    url: str
    legalMode: LegalMode = "safe"
    acknowledgedFullScrape: bool = False


def build_controller() -> EscalationController:
    # tier1 static -> tier2 Chromium -> tier3 Camoufox -> tier4 nodriver/CDP (max stealth + full traffic
    # capture). Tier 4 is appended only when nodriver is installed + enabled; it's the heavy hitter reached
    # only for the hardest anti-bot / SPA sites the lighter tiers can't crack.
    tiers = [Tier1Fetcher(), Tier2Fetcher(), Tier3Fetcher()]
    if _nodriver_available():
        tiers.append(Tier4Fetcher())
    return EscalationController(tiers)


def _env_int(key: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(key, str(default))))
    except ValueError:
        return default


def _env_flag(key: str) -> bool:
    return os.getenv(key, "").strip().lower() in {"1", "true", "yes"}


def _presented_token(x_scraper_token: Optional[str], authorization: Optional[str]) -> str:
    direct = (x_scraper_token or "").strip()
    if direct:
        return direct
    auth = authorization or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _check_token(x_scraper_token: Optional[str], authorization: Optional[str]) -> None:
    token = os.getenv("SCRAPER_TOKEN", "").strip()
    if token and not hmac.compare_digest(_presented_token(x_scraper_token, authorization), token):
        raise HTTPException(status_code=401, detail="unauthorized")


def create_app(controller: Optional[EscalationController] = None) -> FastAPI:
    app = FastAPI(title="mcp-scraper")
    # Fully-open CORS: any origin/header/method, OPTIONS preflight handled automatically.
    # Wildcard origin without credentials is the spec-safe "allow everything" combo.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=86400,
    )
    ctrl = controller or build_controller()
    capture_limit = _env_int("SCRAPER_MAX_CONCURRENCY", 2)
    capture_lock = threading.Lock()
    capture_in_flight = 0

    def acquire_capture_slot() -> bool:
        nonlocal capture_in_flight
        with capture_lock:
            if capture_in_flight >= capture_limit:
                return False
            capture_in_flight += 1
            return True

    def release_capture_slot() -> None:
        nonlocal capture_in_flight
        with capture_lock:
            capture_in_flight = max(0, capture_in_flight - 1)

    @app.post("/capture", response_model=CaptureBundle, response_model_exclude_none=True)
    async def capture(
        req: CaptureRequest,
        x_scraper_token: Optional[str] = Header(default=None),
        authorization: Optional[str] = Header(default=None),
    ) -> JSONResponse:
        _check_token(x_scraper_token, authorization)
        if not acquire_capture_slot():
            raise HTTPException(status_code=503, detail="scraper capture concurrency limit reached")

        try:
            if _env_flag("SCRAPER_INLINE_CAPTURE"):
                bundle = _capture_sync(req, ctrl)
            else:
                loop = asyncio.get_running_loop()
                bundle = await loop.run_in_executor(None, _capture_sync, req, ctrl)
            return JSONResponse(bundle.model_dump(mode="json", by_alias=True, exclude_none=True))
        finally:
            release_capture_slot()

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


def _capture_sync(req: CaptureRequest, ctrl: EscalationController) -> CaptureBundle:
    # SSRF guard: this server-side fetcher must not be aimed at internal/loopback/metadata targets via a
    # caller-supplied URL. Reject non-public or non-http(s) URLs before robots.txt or any tier fetch runs.
    if not _url_allowed(req.url):
        raise HTTPException(
            status_code=400,
            detail="refusing to fetch a non-public or non-http(s) URL (SSRF guard); "
            "set SCRAPER_ALLOW_PRIVATE_HOSTS=1 to allow internal hosts you control.",
        )
    # session is extension-only - the server-side scraper never acts in a user's session.
    if req.legalMode == "session":
        return empty_bundle(req.url, req.legalMode, robots_allowed=False)
    # full_scrape requires explicit acknowledgement (04); otherwise treat as safe.
    effective: LegalMode = req.legalMode
    if effective == "full_scrape" and not req.acknowledgedFullScrape:
        effective = "safe"
    # safe mode: honor robots.txt; disallow -> content-free bundle.
    if effective == "safe" and not robots_allows(req.url):
        return empty_bundle(req.url, effective, robots_allowed=False)
    return ctrl.capture(req.url, effective)


app = create_app()
