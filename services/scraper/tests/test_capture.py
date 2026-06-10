"""Pure-core tests: escalation (fake fetchers), URL templating, schema inference, bundle assembly."""

from scraper.capture import (
    EscalationController,
    FetchResult,
    RawNetworkCall,
    assemble_bundle,
    dedupe_network_calls,
    infer_schema,
    looks_like_bot_wall,
    snapshot_page,
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
    # discovery=False: the classic fast-path - stop at the first sufficient tier.
    bundle = EscalationController([t1, t2]).capture("https://x.com", "safe", discovery=False)
    assert bundle.tier == 1
    assert t1.called and not t2.called  # never escalated past success


def test_discovery_mode_escalates_past_a_non_browser_tier_to_capture_traffic():
    # A tier-1 (no network, not browser-rendered) result is NOT sufficient in discovery mode: escalate to the
    # browser tier so XHR/fetch traffic gets captured into tools. This is the default product behavior.
    t1, t2 = FakeTier(1, _ok("t1")), FakeTier(2, _ok("t2"))
    bundle = EscalationController([t1, t2]).capture("https://x.com", "safe", discovery=True)
    assert bundle.tier == 2
    assert t1.called and t2.called


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
    shell = FetchResult(html="<html><body><div>loading...</div><script>fetch('/api/x')</script></body></html>",
                        status=200, rendered_with_js=False)
    t1 = FakeTier(1, shell)
    t2 = FakeTier(2, FetchResult(html="<html>rendered</html>", status=200, rendered_with_js=True))
    bundle = EscalationController([t1, t2]).capture("https://spa.com", "safe")
    assert bundle.tier == 2  # did not short-circuit on the 200 shell
    assert t1.called and t2.called


def test_shell_falls_back_to_best_when_browser_tiers_unavailable():
    # Tier-1 shell is insufficient, but if all browser tiers fail we keep the shell (not an empty bundle).
    shell = FetchResult(html="<html><body><div>loading...</div><script>x()</script></body></html>",
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
    assert looks_like_bot_wall("<html>x</html>", "Client Challenge")
    assert looks_like_bot_wall("<html>x</html>", "Human verification - Stack Overflow")
    assert looks_like_bot_wall("<html>Please enable JavaScript and cookies to continue</html>")
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
                request_body={"query": "shoe", "page": 1},
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
    assert cap.requestBodySchema == {"type": "object", "properties": {"query": {"type": "string"}, "page": {"type": "integer"}}}
    assert cap.responseSchema == {"type": "object", "properties": {"id": {"type": "integer"}}}


def test_dedupe_network_calls_keeps_best_schema_rich_representative():
    weak = RawNetworkCall(
        method="get",
        raw_url="https://e.com/api/items/1?sort=asc",
        request_headers={},
        status_code=304,
        content_type="application/json",
    )
    rich = RawNetworkCall(
        method="GET",
        raw_url="https://e.com/api/items/2?sort=desc",
        request_headers={},
        status_code=200,
        content_type="application/json",
        response_body={"id": 2},
    )
    distinct_query_shape = RawNetworkCall(
        method="GET",
        raw_url="https://e.com/api/items/2?sort=desc&page=1",
        request_headers={},
        status_code=200,
        content_type="application/json",
        response_body={"id": 2},
    )

    deduped = dedupe_network_calls([weak, rich, distinct_query_shape])

    assert deduped == [rich, distinct_query_shape]


def test_snapshot_page_extracts_visible_text_headings_forms_and_actions():
    html = """<!doctype html><html><body>
      <h1>Search Books</h1>
      <form action="/search" method="get">
        <input type="search" name="q" placeholder="Search">
        <button type="submit">Go</button>
      </form>
      <a href="/catalogue/a-light-in-the-attic_1000/index.html">A Light in the Attic</a>
      <script>secret()</script>
    </body></html>"""

    page = snapshot_page(html, "https://books.example.com/")

    assert page.visibleText is not None
    assert "Search Books" in page.visibleText
    assert "secret" not in page.visibleText
    assert page.headings == ["Search Books"]
    assert page.forms is not None
    form = page.forms[0]
    assert form.method == "GET"
    assert form.action == "https://books.example.com/search"
    assert form.purpose == "search"
    assert form.fields[0].name == "q"
    assert form.fields[0].type == "search"
    assert form.fields[0].required is True
    assert page.actions is not None
    assert any(action.kind == "link" and action.href == "https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html" for action in page.actions)


def test_assemble_bundle_includes_page_snapshot_for_all_tiers():
    result = FetchResult(
        html="<html><body><h2>Results</h2><form action='/s'><input name='q'></form></body></html>",
        status=200,
        rendered_with_js=False,
    )

    bundle = assemble_bundle("https://example.com/", "safe", 1, result)

    assert bundle.page is not None
    assert bundle.page.headings == ["Results"]
    assert bundle.page.forms is not None
    assert bundle.page.forms[0].purpose == "search"


def test_snapshot_page_extracts_schema_only_app_state_hints():
    html = """<html><body>
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"products":[{"__typename":"Product","id":7,"name":"Shoe"}]}},"buildId":"abc"}
      </script>
    </body></html>"""

    page = snapshot_page(html, "https://shop.example.com/")

    assert page.appState is not None
    hint = page.appState[0]
    assert hint.source == "__NEXT_DATA__"
    assert hint.keys == ["props", "buildId"]
    assert hint.types == ["Product"]
    dumped = hint.model_dump(by_alias=True)
    assert dumped["schema"]["type"] == "object"
    assert "Shoe" not in str(dumped)
    assert "abc" not in str(dumped)
