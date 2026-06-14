import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchPublicHttpUrl, parseRobotsTxt, readResponseTextWithLimit } from "@mcp/generator/lean";

/**
 * Robots policy gate that runs BEFORE we scrape a site to build a server.
 *
 *  - "respect" (default): obey the target's robots.txt - refuse to scrape a path it Disallows for User-agent: *.
 *  - "full": ignore robots.txt entirely. Meant for sites the user OWNS or is authorized to access; the user
 *    carries responsibility for that use.
 *
 * The policy is resolved per call with this precedence: explicit tool arg > FORGE_ROBOTS env > a real user
 * prompt via MCP elicitation (when the client supports it) > safe default ("respect"). We never silently
 * choose to ignore robots.txt - a declined/cancelled prompt falls back to "respect".
 */

export type RobotsPolicy = "respect" | "full";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 urlmcp";
const ROBOTS_TIMEOUT_MS = Number(process.env["FORGE_ROBOTS_TIMEOUT_MS"]) || 6_000;
const ROBOTS_MAX_BYTES = 512_000;

export interface RobotsDecision {
  /** Whether robots.txt permits this path (true also when no robots.txt exists / it is unreachable). */
  allowed: boolean;
  /** Did we actually read a robots.txt body? (false => 404 / network error => fail-open allowed). */
  fetched: boolean;
  /** The matching `Disallow:` rule when blocked, for the explanation message. */
  disallowRule?: string;
}

export interface RobotsResolution {
  policy: RobotsPolicy;
  source: "arg" | "env" | "prompt" | "declined" | "default";
}

/** Map loose user/env/LLM input to a policy. Unknown -> undefined (so the next precedence tier is tried). */
export function normalizeRobotsPolicy(v: unknown): RobotsPolicy | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (["respect", "safe", "obey", "follow", "true", "1"].includes(s)) return "respect";
  if (["full", "ignore", "off", "full_scrape", "false", "0"].includes(s)) return "full";
  return undefined;
}

/** First `Disallow:` prefix matching `path` (a trailing `*` is treated as a prefix), else undefined. */
export function matchDisallow(path: string, disallow: string[]): string | undefined {
  for (const rule of disallow) {
    const prefix = rule.replace(/\*+$/, "");
    if (prefix !== "" && path.startsWith(prefix)) return rule;
  }
  return undefined;
}

/**
 * Fetch + evaluate the target's robots.txt for `User-agent: *`. Fail-OPEN (allowed) when robots.txt is missing
 * or unreachable - the gate's job is to honor an explicit Disallow, not to block a site that simply has no
 * robots.txt. Bounded by a short timeout and a small byte cap.
 */
export async function checkRobots(targetUrl: string): Promise<RobotsDecision> {
  let origin = "";
  let path = "/";
  try {
    const u = new URL(targetUrl);
    origin = u.origin;
    path = (u.pathname || "/") + (u.search || "");
  } catch {
    return { allowed: true, fetched: false };
  }
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await fetchPublicHttpUrl(robotsUrl, {
      headers: { accept: "text/plain", "user-agent": UA },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    }, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    if (!res.ok) return { allowed: true, fetched: false }; // 404 / no robots.txt => nothing disallowed
    const text = await readResponseTextWithLimit(res, ROBOTS_MAX_BYTES);
    const rule = matchDisallow(path, parseRobotsTxt(text).disallow);
    return { allowed: !rule, fetched: true, disallowRule: rule };
  } catch {
    return { allowed: true, fetched: false }; // unreachable robots.txt must not hard-block
  }
}

/** Decide the robots policy for this scrape (see module doc for precedence). Prompts the user when possible. */
export async function resolveRobotsPolicy(
  server: McpServer,
  opts: { url: string; explicit?: unknown },
): Promise<RobotsResolution> {
  const arg = normalizeRobotsPolicy(opts.explicit);
  if (arg) return { policy: arg, source: "arg" };
  const env = normalizeRobotsPolicy(process.env["FORGE_ROBOTS"]);
  if (env) return { policy: env, source: "env" };

  const low = server.server;
  const supportsElicit = Boolean(low.getClientCapabilities?.()?.elicitation);
  if (supportsElicit) {
    try {
      const res = await low.elicitInput({
        message:
          `urlmcp is about to scrape ${opts.url} to build an MCP server.\n` +
          `Respect the site's robots.txt, or run in FULL MODE (ignore robots.txt)?\n` +
          `Only choose full mode for a site you own or are authorized to access - you are responsible for your use of it.`,
        requestedSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              title: "Scrape policy",
              description: "Respect robots.txt, or full mode (ignore it - at your own risk).",
              enum: ["respect", "full"],
              enumNames: [
                "Respect robots.txt (recommended)",
                "Full mode - ignore robots.txt (I own / am authorized for this site)",
              ],
            },
          },
          required: ["mode"],
        },
      });
      if (res.action === "accept") {
        const picked = normalizeRobotsPolicy(res.content?.["mode"]);
        if (picked) return { policy: picked, source: "prompt" };
      }
      return { policy: "respect", source: "declined" }; // decline / cancel => safe default, never silent full mode
    } catch {
      /* client advertised elicitation but the round-trip failed; fall through to the safe default */
    }
  }
  return { policy: "respect", source: "default" };
}

/** Error body returned when "respect" mode hits a Disallowed path - tells the user how to override if it's their site. */
export function robotsBlockedMessage(url: string, rule?: string): string {
  return [
    `Refusing to scrape ${url}: the site's robots.txt disallows this path${rule ? ` (Disallow: ${rule})` : ""}, and you chose to respect it.`,
    `If you OWN this site or are authorized to access it, re-run in full mode:`,
    `  - pass robots: "full" to this tool, or set FORGE_ROBOTS=full in the server environment.`,
    `You are responsible for ensuring your use complies with the site's terms and applicable law.`,
  ].join("\n");
}

/** One-line status for the tool output so the chosen policy + outcome are visible to the user. */
export function robotsStatus(resolution: RobotsResolution, decision?: RobotsDecision): string {
  if (resolution.policy === "full") {
    return "Robots: FULL MODE - robots.txt ignored (you asserted ownership / authorization).";
  }
  if (decision && !decision.fetched) return "Robots: respected (no robots.txt published).";
  return "Robots: respected (path allowed by robots.txt).";
}
