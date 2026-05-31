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

_SPA = (Path(__file__).resolve().parent / "fixtures" / "spa.html").read_text()
_STATIC = "<!doctype html><html><head><title>Static</title></head><body><h1>hello static</h1></body></html>"


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
        if self.path == "/static":
            self._send(_STATIC, "text/html")
        elif self.path == "/spa":
            self._send(_SPA, "text/html")
        elif self.path.startswith("/api/items/"):
            n = self.path.rsplit("/", 1)[-1]
            self._send(json.dumps({"id": int(n) if n.isdigit() else 0}), "application/json")
        elif self.path == "/robots.txt":
            self._send("User-agent: *\nAllow: /\n", "text/plain")
        else:
            self._send("not found", "text/plain", 404)


class LocalServer:
    def __init__(self):
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
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
