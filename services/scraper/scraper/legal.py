"""Cross-language secret-list scrubbing (docs/04-legal-modes.md).

Reads the SAME canonical packages/types/src/secret-list.json the TypeScript side imports, and reimplements
the glob -> regex / scrub logic identically. Mirror of @mcp/types legal.ts. Keep these in lockstep — the
golden fixture tests/fixtures parity test fails CI if they drift.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path


def _candidate_secret_list_paths() -> list[Path]:
    here = Path(__file__).resolve()
    paths: list[Path] = []
    if env_path := os.getenv("MCP_SECRET_LIST_PATH"):
        paths.append(Path(env_path))
    if len(here.parents) > 3:
        paths.append(here.parents[3] / "packages" / "types" / "src" / "secret-list.json")
    paths.append(Path.cwd() / "packages" / "types" / "src" / "secret-list.json")
    paths.append(here.with_name("secret-list.json"))
    return paths


def _secret_list_path() -> Path:
    for path in _candidate_secret_list_paths():
        if path.exists():
            return path
    candidates = ", ".join(str(p) for p in _candidate_secret_list_paths())
    raise FileNotFoundError(f"secret-list.json not found; checked: {candidates}")


@lru_cache(maxsize=1)
def _secret_list() -> tuple[tuple[str, ...], tuple[re.Pattern[str], ...]]:
    data = json.loads(_secret_list_path().read_text())
    headers = tuple(h.lower() for h in data["headers"])
    patterns = tuple(_glob_to_regex(g) for g in data["fieldPatterns"])
    return headers, patterns


def _glob_to_regex(glob: str) -> re.Pattern[str]:
    """`*` = any run. Anchored, case-insensitive. Mirrors legal.ts globToRegExp exactly."""
    parts = [re.escape(part) for part in glob.split("*")]
    return re.compile("^" + ".*".join(parts) + "$", re.IGNORECASE)


def is_secret_header(name: str) -> bool:
    headers, _ = _secret_list()
    return name.lower() in headers


def is_secret_field(name: str) -> bool:
    _, patterns = _secret_list()
    return any(p.match(name) for p in patterns)


def scrub_headers(headers: dict[str, str]) -> dict[str, str]:
    """Strip secret-list headers/fields. Applied before any persistence/transmission (04). Never mutates."""
    return {k: v for k, v in headers.items() if not is_secret_header(k) and not is_secret_field(k)}
