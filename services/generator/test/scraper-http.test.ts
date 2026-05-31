import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HttpScraper } from "../src/index.js";

const repoFixture = (rel: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), "utf8"));

test("HttpScraper preserves full_scrape acknowledgement across the generator -> scraper seam", async () => {
  const realFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return Response.json(repoFixture("capture-bundles/sample-public.json"));
  }) as typeof fetch;

  try {
    await new HttpScraper("http://scraper.test").capture("https://example.com/products", "full_scrape");
    assert.equal(body.legalMode, "full_scrape");
    assert.equal(body.acknowledgedFullScrape, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
