/**
 * Closed-loop LIVE verification demo (not a test - it hits the real network).
 *
 * Runs the full pipeline on real captured sites (infer tools -> execute them against the live web) and prints
 * an honest report: which generated tools are verified live, which are dead/blocked, which aren't verifiable
 * (browser tools, non-idempotent methods, placeholder targets), and - the headline - which tools' {param}
 * templates GENERALIZE to a fresh value that was never captured.
 *
 *   npm run build --workspace=@mcp/generator && node services/generator/test/verify-live-demo.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inferTools, HeuristicInferenceClient } from "../dist/src/index.js";
import { verifyTools, httpProbe } from "../dist/src/tool-verifier.js";

const dir = fileURLToPath(new URL("../../../fixtures/real-world-html/", import.meta.url));
const probe = httpProbe({ timeoutMs: 12_000 });

// Fresh, NEVER-captured param values - if a tool's {param} template still returns real content for these,
// the tool provably generalizes to unseen inputs (not just "the one URL we scraped is still up").
const freshValues = { gem: "rspec", id: "tipping-the-velvet_999" };

const sites = [
  ["rubygems-rails.html", "https://rubygems.org/gems/rails"],
  ["pypi-requests.html", "https://pypi.org/project/requests/"],
  ["hackernews.html", "https://news.ycombinator.com/"],
  ["books-toscrape.html", "https://books.toscrape.com/"],
];

const icon = { verified: "[OK]", dead: "[DEAD]", blocked: "[BOT]", not_verifiable: "[skip]" };
const tot = { verified: 0, dead: 0, blocked: 0, notVerifiable: 0, generalized: 0 };

console.log("\n=== CLOSED-LOOP LIVE VERIFICATION (generated tools, executed against the real web) ===");
for (const [file, url] of sites) {
  const html = readFileSync(dir + file, "utf8");
  const bundle = {
    bundleId: "00000000-0000-4000-8000-000000000000", source: "scraper", url,
    capturedAt: "2026-06-02T00:00:00.000Z", legalMode: "safe", tier: 1,
    dom: { html, domHash: "sha256:x" }, network: [], meta: { renderedWithJs: false },
  };
  const { result } = await inferTools(bundle, new HeuristicInferenceClient());
  const report = await verifyTools(result.tools, probe, { freshValues });
  console.log(`\n- ${url}`);
  for (const v of report.verifications) {
    const gen = v.generalized === true ? "  * GENERALIZES to a fresh, un-captured value" : "";
    console.log(`    ${icon[v.status]} ${v.name.padEnd(22)} ${v.status}${v.httpStatus ? " (" + v.httpStatus + ")" : ""}${v.reason ? " - " + v.reason : ""}${gen}`);
  }
  console.log(`    => verified ${report.verified} | dead ${report.dead} | blocked ${report.blocked} | not-verifiable ${report.notVerifiable} | generalized ${report.generalized}`);
  tot.verified += report.verified; tot.dead += report.dead; tot.blocked += report.blocked;
  tot.notVerifiable += report.notVerifiable; tot.generalized += report.generalized;
}
console.log(`\n=== TOTAL across ${sites.length} real sites ===`);
console.log(`  verified live: ${tot.verified} | dead: ${tot.dead} | blocked: ${tot.blocked} | not-verifiable: ${tot.notVerifiable} | template-generalized: ${tot.generalized}\n`);
