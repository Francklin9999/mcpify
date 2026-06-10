"""A tiny local HTTP server for the real-fetch tests (no live internet).

Serves:
  GET /static       -> a plain server-rendered page (tier 1)
  GET /spa          -> tests/fixtures/spa.html, whose JS fires GET /api/items/1 (tier 2 capture)
  GET /api/items/{n}-> JSON {"id": n} (the load-time XHR the scraper must capture)
  GET /robots.txt   -> allow all
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_FIXTURES = Path(__file__).resolve().parent / "fixtures"
_SPA = (_FIXTURES / "spa.html").read_text()
_SCROLL_SEARCH = (_FIXTURES / "scroll-search.html").read_text()
_STATIC = "<!doctype html><html><head><title>Static</title></head><body><h1>hello static</h1></body></html>"

# Endpoints that fire ONLY on interaction (scroll/search/load-more) - never on load. Used to prove the
# interaction-driven capture pass surfaces them.
_INTERACTION_ENDPOINTS = {"/api/more", "/api/search", "/api/loadmore"}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _send(self, body: str, ctype: str, status: int = 200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]  # strip query string for routing (search hits /api/search?q=...)
        if path == "/static":
            self._send(_STATIC, "text/html")
        elif path == "/spa":
            self._send(_SPA, "text/html")
        elif path == "/scroll-search":
            self._send(_SCROLL_SEARCH, "text/html")
        elif path.startswith("/api/items/"):
            n = path.rsplit("/", 1)[-1]
            self._send(json.dumps({"id": int(n) if n.isdigit() else 0}), "application/json")
        elif path in _INTERACTION_ENDPOINTS:
            self._send(json.dumps({"endpoint": path}), "application/json")
        elif path == "/robots.txt":
            self._send("User-agent: *\nAllow: /\n", "text/plain")
        else:
            self._send("not found", "text/plain", 404)


class LocalServer:
    def __init__(self):
        try:
            self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        except PermissionError as exc:
            import pytest

            pytest.skip(f"local HTTP server unavailable in this environment: {exc}")
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._httpd.shutdown()
        self._httpd.server_close()
