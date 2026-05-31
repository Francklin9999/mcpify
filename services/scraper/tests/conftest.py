import json
import sys
from pathlib import Path

import pytest

# Make the `scraper` package importable when running pytest from the package dir.
_PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PKG_ROOT))

# Repo-root golden fixtures — the SAME corpus the TypeScript contract tests load (01 §Cross-language).
_FIXTURES = _PKG_ROOT.parents[1] / "fixtures"


@pytest.fixture
def repo_fixture():
    def _load(rel: str):
        return json.loads((_FIXTURES / rel).read_text())

    return _load
