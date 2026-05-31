"""FastAPI surface: POST /capture -> CaptureBundle (docs/services/scraper.md, 03 Flow A).

The generator calls this (sync HTTP, v1). Legal gate (04): `safe` honors robots.txt; `full_scrape` is only
reachable with the acknowledgement flag (the web app gates it); `session` is extension-only and rejected.
"""

from __future__ import annotations

from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

from .capture import EscalationController, empty_bundle
from .contracts import CaptureBundle, LegalMode
from .robots import robots_allows
from .tiers import Tier1Fetcher, Tier2Fetcher, Tier3Fetcher


class CaptureRequest(BaseModel):
    url: str
    legalMode: LegalMode = "safe"
    acknowledgedFullScrape: bool = False


def build_controller() -> EscalationController:
    return EscalationController([Tier1Fetcher(), Tier2Fetcher(), Tier3Fetcher()])


def create_app(controller: Optional[EscalationController] = None) -> FastAPI:
    app = FastAPI(title="mcp-scraper")
    ctrl = controller or build_controller()

    @app.post("/capture", response_model=CaptureBundle, response_model_exclude_none=True)
    def capture(req: CaptureRequest) -> CaptureBundle:
        # session is extension-only — the server-side scraper never acts in a user's session.
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

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
