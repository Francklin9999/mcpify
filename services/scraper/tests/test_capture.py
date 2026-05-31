"""Pure-core tests: escalation (fake fetchers), URL templating, schema inference, bundle assembly."""

from scraper.capture import (
    EscalationController,
    FetchResult,
    RawNetworkCall,
    assemble_bundle,
    infer_schema,
    looks_like_bot_wall,
    template_url,
)


class FakeTier:
    def __init__(self, tier, result):
        self.tier = tier
        self._result = result
        self.called = False

    def fetch(self, url):
        self.called = True
        return self._result


def _ok(tier_label):
    return FetchResult(html=f"<html>{tier_label}</html>", status=200, rendered_with_js=tier_label != "t1")


def test_escalation_uses_first_successful_tier():
    t1, t2 = FakeTier(1, _ok("t1")), FakeTier(2, _ok("t2"))
    bundle = EscalationController([t1, t2]).capture("https://x.com", "safe")
    assert bundle.tier == 1
    assert t1.called and not t2.called  # never escalated past success


def test_escalation_falls_through_to_next_tier():
    t1, t2, t3 = FakeTier(1, None), FakeTier(2, _ok("t2")), FakeTier(3, _ok("t3"))
    bundle = EscalationController([t1, t2, t3]).capture("https://x.com", "safe")
    assert bundle.tier == 2
    assert t1.called and t2.called and not t3.called


def test_all_tiers_fail_yields_content_free_bundle():
    bundle = EscalationController([FakeTier(1, None), FakeTier(2, None)]).capture("https://x.com", "safe")
    assert bundle.tier is None
    assert bundle.dom.html == ""
    assert bundle.network == []


def test_tier1_script_shell_is_insufficient_and_escalates():
    # A script-bearing shell with little visible text is NOT sufficient at tier 1 -> escalate to tier 2.
    shell = FetchResult(html="<html><body><div>loading…</div><script>fetch('/api/x')</script></body></html>",
                        status=200, rendered_with_js=False)
    t1 = FakeTier(1, shell)
    t2 = FakeTier(2, FetchResult(html="<html>rendered</html>", status=200, rendered_with_js=True))
    bundle = EscalationController([t1, t2]).capture("https://spa.com", "safe")
    assert bundle.tier == 2  # did not short-circuit on the 200 shell
    assert t1.called and t2.called


def test_shell_falls_back_to_best_when_browser_tiers_unavailable():
    # Tier-1 shell is insufficient, but if all browser tiers fail we keep the shell (not an empty bundle).
    shell = FetchResult(html="<html><body><div>loading…</div><script>x()</script></body></html>",
                        status=200, rendered_with_js=False)
    bundle = EscalationController([FakeTier(1, shell), FakeTier(2, None), FakeTier(3, None)]).capture("https://s.com", "safe")
    assert bundle.tier == 1  # best-effort fallback, not empty
    assert "loading" in bundle.dom.html


def test_raising_tier_is_treated_as_failure_and_escalates():
    class Boom:
        tier = 1

        def fetch(self, url):
            raise RuntimeError("tier blew up")

    bundle = EscalationController([Boom(), FakeTier(2, _ok("t2"))]).capture("https://x.com", "safe")
    assert bundle.tier == 2


def test_bot_wall_detection():
    assert looks_like_bot_wall("<html>Please complete the CAPTCHA to continue</html>")
    assert looks_like_bot_wall("<html>Enter the characters you see below</html>")
    assert looks_like_bot_wall("<html>x</html>", "Just a moment...")  # cloudflare title
    assert not looks_like_bot_wall("<html>A normal article about football.</html>", "Wikipedia")


def test_bot_wall_at_tier1_escalates_to_stealth_tier():
    # Tier 1 returns a 200 captcha page (Amazon-style) -> NOT sufficient -> escalate to the browser tier.
    wall = FetchResult(html="<html>Enter the characters you see (captcha)</html>", status=200, rendered_with_js=False)
    t1 = FakeTier(1, wall)
    t2 = FakeTier(2, FetchResult(html="<html>real product page</html>", status=200, rendered_with_js=True))
    bundle = EscalationController([t1, t2]).capture("https://shop.com", "safe")
    assert bundle.tier == 2, "must escalate past the tier-1 bot wall"
    assert t1.called and t2.called


def test_all_tiers_bot_walled_returns_best_effort_not_empty():
    wall = FetchResult(html="<html>captcha challenge</html>", status=200, rendered_with_js=False)
    bundle = EscalationController([FakeTier(1, wall), FakeTier(2, wall)]).capture("https://shop.com", "safe")
    assert bundle.tier == 1  # best-effort fallback (still generates a content tool downstream)
    assert "captcha" in bundle.dom.html


def test_template_url_replaces_id_segments():
    assert template_url("https://e.com/api/products/42") == "/api/products/{id}"
    assert template_url("https://e.com/api/u/123e4567-e89b-42d3-a456-426614174000/x") == "/api/u/{id}/x"
    assert template_url("https://e.com/api/search?q=shoes") == "/api/search"


def test_infer_schema_is_shallow_and_value_free():
    s = infer_schema({"id": 1, "name": "x", "ok": True, "nested": {"deep": 1}})
    assert s["type"] == "object"
    assert s["properties"]["id"] == {"type": "integer"}
    assert s["properties"]["name"] == {"type": "string"}
    assert s["properties"]["ok"] == {"type": "boolean"}
    assert s["properties"]["nested"] == {"type": "object"}  # depth-capped, no values


def test_assemble_bundle_scrubs_network_headers():
    result = FetchResult(
        html="<html></html>",
        status=200,
        rendered_with_js=True,
        network=[
            RawNetworkCall(
                method="GET",
                raw_url="https://e.com/api/items/7",
                request_headers={"accept": "application/json", "authorization": "Bearer x"},
                status_code=200,
                content_type="application/json",
                response_body={"id": 7},
            )
        ],
    )
    bundle = assemble_bundle("https://e.com/items", "safe", 2, result)
    assert bundle.tier == 2
    cap = bundle.network[0]
    assert cap.urlPattern == "/api/items/{id}"
    assert "authorization" not in cap.requestHeaders  # scrubbed before construction
    assert cap.requestHeaders == {"accept": "application/json"}
    assert cap.responseSchema == {"type": "object", "properties": {"id": {"type": "integer"}}}
