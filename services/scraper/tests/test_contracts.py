"""Cross-language contract parity: the pydantic mirror agrees with @mcp/types on the golden corpus."""

import pytest
from pydantic import ValidationError

from scraper.contracts import CaptureBundle, NetworkCapture


def test_accepts_the_golden_public_bundle(repo_fixture):
    bundle = CaptureBundle.model_validate(repo_fixture("capture-bundles/sample-public.json"))
    assert bundle.source == "scraper"
    assert len(bundle.network) == 1
    assert bundle.dom.selectorsOfInterest is not None
    assert len(bundle.dom.selectorsOfInterest) == 2


def test_rejects_missing_required_field(repo_fixture):
    bad = repo_fixture("capture-bundles/sample-public.json")
    del bad["dom"]["domHash"]
    with pytest.raises(ValidationError):
        CaptureBundle.model_validate(bad)


def test_rejects_unknown_source(repo_fixture):
    bad = repo_fixture("capture-bundles/sample-public.json")
    bad["source"] = "carrier-pigeon"
    with pytest.raises(ValidationError):
        CaptureBundle.model_validate(bad)


def test_rejects_non_url_uuid_datetime_matching_zod_constraints(repo_fixture):
    """Parity: pydantic must enforce the SAME url/uuid/datetime constraints as the TS zod, or Python could
    emit a bundle pydantic accepts but the TS contract rejects (producer->consumer asymmetry)."""
    for field, bad in [("url", "not a url"), ("bundleId", "not-a-uuid"), ("capturedAt", "yesterday")]:
        broken = repo_fixture("capture-bundles/sample-public.json")
        broken[field] = bad
        with pytest.raises(ValidationError):
            CaptureBundle.model_validate(broken)


def test_accepts_optional_rich_page_snapshot(repo_fixture):
    bundle = repo_fixture("capture-bundles/sample-public.json")
    bundle["page"] = {
        "visibleText": "hello",
        "headings": ["Heading"],
        "actions": [{"kind": "button", "label": "Search", "selector": "button.search"}],
        "forms": [{
            "selector": "form.search",
            "method": "GET",
            "purpose": "search",
            "fields": [{"name": "q", "type": "search", "required": True, "selector": "input[name=q]"}],
        }],
        "appState": [{"source": "__NEXT_DATA__", "keys": ["props"], "schema": {"type": "object"}}],
    }
    assert CaptureBundle.model_validate(bundle).page is not None


def test_network_capture_rejects_a_secret_list_header():
    """Fail-closed backstop - mirror of the TS NetworkCapture.superRefine (04)."""
    leaky = {
        "method": "GET",
        "urlPattern": "/api/x",
        "rawUrl": "https://example.com/api/x",
        "requestHeaders": {"accept": "application/json", "authorization": "Bearer leak"},
        "statusCode": 200,
        "contentType": "application/json",
    }
    with pytest.raises(ValidationError):
        NetworkCapture.model_validate(leaky)

    clean = {**leaky, "requestHeaders": {"accept": "application/json"}}
    assert NetworkCapture.model_validate(clean).statusCode == 200
