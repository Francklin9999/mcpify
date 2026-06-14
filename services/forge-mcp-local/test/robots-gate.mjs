// Hermetic test for the robots policy gate: policy normalization, Disallow matching, the resolution
// precedence (arg > env > elicitation prompt > default), and a live robots.txt check against a local server.
// Run: node test/robots-gate.mjs
import assert from "node:assert";
import http from "node:http";
import {
  normalizeRobotsPolicy,
  matchDisallow,
  resolveRobotsPolicy,
  checkRobots,
  robotsBlockedMessage,
  robotsStatus,
} from "../dist/src/robots-gate.js";

let failed = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const bad = (n, e) => { failed++; console.error(`  FAIL: ${n} -> ${e}`); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e?.message ?? e); } }

// Fake McpServer: only `.server.getClientCapabilities()` + `.server.elicitInput()` are touched by the gate.
function fakeServer({ elicitation = false, elicit } = {}) {
  return {
    server: {
      getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}),
      elicitInput: elicit ?? (async () => { throw new Error("elicitInput should not be called"); }),
    },
  };
}

const savedEnv = { ...process.env };
const resetEnv = () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  for (const k of Object.keys(savedEnv)) process.env[k] = savedEnv[k];
};

await check("normalizeRobotsPolicy maps synonyms + unknowns", () => {
  for (const v of ["respect", "Respect", " SAFE ", "obey", "follow", "true", "1"]) {
    assert.strictEqual(normalizeRobotsPolicy(v), "respect", `respect <- ${v}`);
  }
  for (const v of ["full", "ignore", "OFF", "full_scrape", "false", "0"]) {
    assert.strictEqual(normalizeRobotsPolicy(v), "full", `full <- ${v}`);
  }
  for (const v of ["", "  ", undefined, null, "maybe", 42]) {
    assert.strictEqual(normalizeRobotsPolicy(v), undefined, `undefined <- ${v}`);
  }
});

await check("matchDisallow honors prefixes, trailing-* wildcards, and Disallow: /", () => {
  assert.strictEqual(matchDisallow("/account/settings", ["/account"]), "/account");
  assert.strictEqual(matchDisallow("/search?q=x", ["/search*"]), "/search*");
  assert.strictEqual(matchDisallow("/anything", ["/"]), "/"); // Disallow: / blocks everything
  assert.strictEqual(matchDisallow("/public/page", ["/account", "/admin"]), undefined);
  assert.strictEqual(matchDisallow("/x", []), undefined);
  assert.strictEqual(matchDisallow("/x", [""]), undefined); // empty Disallow (allow all) matches nothing
});

await check("resolveRobotsPolicy: explicit arg wins over everything (no prompt)", async () => {
  resetEnv();
  process.env.FORGE_ROBOTS = "respect";
  const r = await resolveRobotsPolicy(fakeServer({ elicitation: true }), { url: "https://x.example", explicit: "full" });
  assert.deepStrictEqual(r, { policy: "full", source: "arg" });
  resetEnv();
});

await check("resolveRobotsPolicy: FORGE_ROBOTS env wins when no arg (no prompt)", async () => {
  resetEnv();
  process.env.FORGE_ROBOTS = "full";
  const r = await resolveRobotsPolicy(fakeServer({ elicitation: true }), { url: "https://x.example" });
  assert.deepStrictEqual(r, { policy: "full", source: "env" });
  resetEnv();
});

await check("resolveRobotsPolicy: no elicitation capability => safe default 'respect'", async () => {
  resetEnv();
  delete process.env.FORGE_ROBOTS;
  const r = await resolveRobotsPolicy(fakeServer({ elicitation: false }), { url: "https://x.example" });
  assert.deepStrictEqual(r, { policy: "respect", source: "default" });
});

await check("resolveRobotsPolicy: accepted prompt returns the chosen policy", async () => {
  resetEnv();
  delete process.env.FORGE_ROBOTS;
  const r = await resolveRobotsPolicy(
    fakeServer({ elicitation: true, elicit: async () => ({ action: "accept", content: { mode: "full" } }) }),
    { url: "https://x.example" },
  );
  assert.deepStrictEqual(r, { policy: "full", source: "prompt" });
});

await check("resolveRobotsPolicy: declined/cancelled prompt falls back to 'respect' (never silent full)", async () => {
  resetEnv();
  delete process.env.FORGE_ROBOTS;
  for (const action of ["decline", "cancel"]) {
    const r = await resolveRobotsPolicy(
      fakeServer({ elicitation: true, elicit: async () => ({ action }) }),
      { url: "https://x.example" },
    );
    assert.deepStrictEqual(r, { policy: "respect", source: "declined" }, action);
  }
});

await check("resolveRobotsPolicy: elicitInput throwing falls through to safe default", async () => {
  resetEnv();
  delete process.env.FORGE_ROBOTS;
  const r = await resolveRobotsPolicy(
    fakeServer({ elicitation: true, elicit: async () => { throw new Error("unsupported"); } }),
    { url: "https://x.example" },
  );
  assert.deepStrictEqual(r, { policy: "respect", source: "default" });
});

await check("robotsBlockedMessage + robotsStatus read sensibly", () => {
  assert.match(robotsBlockedMessage("https://x.example/a", "/a"), /robots\.txt disallows .*Disallow: \/a/s);
  assert.match(robotsBlockedMessage("https://x.example/a", "/a"), /robots: "full"|FORGE_ROBOTS=full/);
  assert.match(robotsStatus({ policy: "full", source: "arg" }), /FULL MODE/);
  assert.match(robotsStatus({ policy: "respect", source: "default" }, { allowed: true, fetched: false }), /no robots\.txt/);
  assert.match(robotsStatus({ policy: "respect", source: "prompt" }, { allowed: true, fetched: true }), /allowed by robots\.txt/);
});

// ---- live checkRobots against a local robots.txt (needs loopback bind; self-skips in a locked-down sandbox) ----
await check("checkRobots: respects Disallow, allows other paths, fail-open on 404", async () => {
  resetEnv();
  process.env.FORGE_ALLOW_PRIVATE_HOSTS = "1"; // checkRobots fetches origin/robots.txt; loopback is private
  const server = http.createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\nDisallow: /admin\n");
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
  } catch (err) {
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      console.log("  SKIP: checkRobots live check needs a loopback bind, which this sandbox blocks.");
      server.close();
      resetEnv();
      return;
    }
    throw err;
  }
  try {
    const blocked = await checkRobots(`${base}/private/secret`);
    assert.deepStrictEqual({ allowed: blocked.allowed, fetched: blocked.fetched, rule: blocked.disallowRule }, { allowed: false, fetched: true, rule: "/private" });
    const allowed = await checkRobots(`${base}/public/page`);
    assert.deepStrictEqual({ allowed: allowed.allowed, fetched: allowed.fetched }, { allowed: true, fetched: true });

    // A site with no robots.txt (404) must fail OPEN (allowed), not block.
    const noRobots = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const base2 = await new Promise((resolve) => noRobots.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${noRobots.address().port}`)));
    const open = await checkRobots(`${base2}/whatever`);
    noRobots.close();
    assert.deepStrictEqual({ allowed: open.allowed, fetched: open.fetched }, { allowed: true, fetched: false });
  } finally {
    server.close();
    resetEnv();
  }
});

if (failed) { console.error(`\nrobots-gate: ${failed} check(s) failed`); process.exit(1); }
console.log("\nrobots-gate: all checks passed");
