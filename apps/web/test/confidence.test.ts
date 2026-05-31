import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceBand, pct } from "../lib/confidence.ts";

test("band derives from confidence + status (the web-ui visual system)", () => {
  assert.equal(confidenceBand(0.97, "active").label, "VERIFIED");
  assert.equal(confidenceBand(0.85, "active").label, "STRONG");
  assert.equal(confidenceBand(0.7, "active").label, "FAIR");
  assert.equal(confidenceBand(0.4, "active").label, "NEEDS HEALING");
});

test("broken forces the low treatment regardless of score; regenerating is transient", () => {
  assert.equal(confidenceBand(0.99, "broken").tone, "low");
  assert.equal(confidenceBand(0.99, "regenerating").tone, "healing");
});

test("pct rounds to a whole percent", () => {
  assert.equal(pct(0.864), 86);
});
