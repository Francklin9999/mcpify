import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupTools } from "../src/tool-cleanup.js";
import type { ToolDefinition } from "@mcp/types";

const http = (name: string, urlPattern: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern, rawUrl: `https://site.example${urlPattern}`, requestHeaders: { accept: "text/html" }, statusCode: 200, contentType: "text/html" },
    paramMapping: {},
  },
  confidence: 0.55,
});

const browser = (name: string, navValue: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  execution: {
    kind: "browser",
    steps: [
      { action: "navigate", value: navValue },
      { action: "waitFor", target: { role: "page", selector: "body" } },
      { action: "extract", value: "json:product" },
    ],
  },
  confidence: 0.66,
});

const PAGE = "https://site.example/listing";

test("drops mis-mined auth/account navigation tools", () => {
  const out = cleanupTools(
    [http("search", "/search"), http("browse_listing", "/login"), http("browse_listing_2", "/users/signup"), http("get_thing", "/thing/{id}")],
    PAGE,
  );
  const names = out.map((t) => t.name);
  assert.ok(!names.includes("browse_listing"), "/login dropped");
  assert.ok(!names.includes("browse_listing_2"), "/users/signup dropped");
  assert.ok(names.includes("search") && names.includes("get_thing"), "real tools kept");
});

test("drops SaaS telemetry hosts and liveness/health probes (dynamic-app infra noise)", () => {
  const httpAt = (name: string, raw: string): ReturnType<typeof http> => {
    const t = http(name, new URL(raw).pathname);
    if (t.execution.kind === "http") t.execution.request.rawUrl = raw;
    return t;
  };
  const out = cleanupTools(
    [
      httpAt("post_query", "https://x9-dsn.algolia.net/1/indexes/Item/query"),
      httpAt("get_settings", "https://telemetry.algolia.com/1/settings"),
      httpAt("get_isalive", "https://t5-in-1.algolia.net/1/isalive"),
      httpAt("get_health", "https://api.example.com/healthz"),
      httpAt("get_metrics", "https://rum.example.com/v1/track"),
    ],
    "https://app.example.com/",
  );
  const names = out.map((t) => t.name);
  assert.deepEqual(names, ["post_query"], `only the real data endpoint survives, got: ${names.join(", ")}`);
});

test("does NOT drop data APIs on generic stats./metrics. hosts (only named monitoring vendors are infra)", () => {
  // Boundary pin: `stats.`/`metrics.` are standard subdomains for REAL data APIs (stats.nba.com, etc.).
  // Only unambiguous monitoring vendors (sentry/datadog/telemetry/...) are treated as infra junk.
  const httpAt = (name: string, raw: string): ReturnType<typeof http> => {
    const t = http(name, new URL(raw).pathname);
    if (t.execution.kind === "http") t.execution.request.rawUrl = raw;
    return t;
  };
  const out = cleanupTools(
    [
      httpAt("get_team_stats", "https://stats.nba.com/stats/teamgamelog?TeamID=1"),
      httpAt("get_metrics", "https://metrics.coolproduct.io/v1/series?id=cpu"),
      httpAt("post_sentry", "https://o123.sentry.io/api/1/envelope/"),
    ],
    "https://app.example.com/",
  );
  const names = out.map((t) => t.name);
  assert.ok(names.includes("get_team_stats"), "stats.nba.com data API survives");
  assert.ok(names.includes("get_metrics"), "metrics.<product> data API survives");
  assert.ok(!names.includes("post_sentry"), "sentry.io monitoring host still dropped");
});

test("does NOT drop legitimate detail pages that merely contain user/account-ish segments", () => {
  // These are exactly the sub-page tools we want to keep - segment-anchored regex must not catch them.
  const out = cleanupTools(
    [http("get_user_page", "/user/{id}"), http("get_account_page", "/account/{id}"), http("get_users_page", "/users/{handle}")],
    PAGE,
  );
  assert.equal(out.length, 3, "no legitimate detail tool dropped");
});

test("never drops the content floor or the captured page, even when the page itself is an auth page", () => {
  const out = cleanupTools([{ ...http("fetch_page_content", "/login"), name: "fetch_page_content" }, http("browse_listing", "/login")], "https://site.example/login");
  const names = out.map((t) => t.name);
  assert.ok(names.includes("fetch_page_content"), "floor kept even though it points at /login");
  // The captured page is /login, so a tool whose pattern == /login is exempt (it's the page itself).
  assert.ok(names.includes("browse_listing"), "tool targeting the captured page itself is exempt");
});

test("repairs a percent-encoded {placeholder} in a browser navigate value", () => {
  const out = cleanupTools([browser("get_product_details", "https://site.example/catalogue/%7Bid%7D/index.html")], PAGE);
  const nav = out[0]!.execution.kind === "browser" ? out[0]!.execution.steps[0]!.value : undefined;
  assert.equal(nav, "https://site.example/catalogue/{id}/index.html", "encoded braces decoded so {id} substitutes");
});

test("repairs a double percent-encoded {{placeholder}} too", () => {
  const out = cleanupTools([browser("x", "https://site.example/p/%7B%7Bid%7D%7D")], PAGE);
  const nav = out[0]!.execution.kind === "browser" ? out[0]!.execution.steps[0]!.value : undefined;
  assert.equal(nav, "https://site.example/p/{{id}}");
});

test("leaves a clean tool list untouched (idempotent) and returns a NEW array", () => {
  const input = [http("search", "/search"), browser("get_x", "https://site.example/x/{{id}}")];
  const out = cleanupTools(input, PAGE);
  assert.deepEqual(out.map((t) => t.name), ["search", "get_x"]);
  assert.notEqual(out, input, "returns a new array, does not mutate input");
});

test("may return empty when every tool was auth junk (caller restores the floor)", () => {
  assert.deepEqual(cleanupTools([http("a", "/login"), http("b", "/signup")], PAGE), []);
});

test("never throws on a malformed page URL", () => {
  assert.doesNotThrow(() => cleanupTools([http("search", "/search")], "not a url"));
});
