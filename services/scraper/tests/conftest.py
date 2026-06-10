import json
import os
import sys
from pathlib import Path

import pytest

# Keep unit tests hermetic: the /capture SSRF guard resolves hostnames, but tests post example.com with a fake
# controller and must not depend on DNS. Default the opt-out on for the suite (test_ssrf.py clears it to test
# the guard itself). Production leaves it unset = guard active.
os.environ.setdefault("SCRAPER_ALLOW_PRIVATE_HOSTS", "1")
# The Codex sandbox does not wake ASGI test requests from worker-thread completions reliably; production leaves
# this unset so captures run in an executor up to SCRAPER_MAX_CONCURRENCY.
os.environ.setdefault("SCRAPER_INLINE_CAPTURE", "1")

# Make the `scraper` package importable when running pytest from the package dir.
_PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PKG_ROOT))

# Repo-root golden fixtures - the SAME corpus the TypeScript contract tests load (01 SCross-language).
_FIXTURES = _PKG_ROOT.parents[1] / "fixtures"


@pytest.fixture
def repo_fixture():
    def _load(rel: str):
        return json.loads((_FIXTURES / rel).read_text())

    return _load
