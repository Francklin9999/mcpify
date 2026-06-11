import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolDefinition, GenerateRequest, aggregateConfidence, type LegalMode, type RegistryEntry } from "@mcp/types";
import { assertPublicHttpUrl, generate, generateServer, chooseBrowserBackend, discoverApiSpecTools, httpFetchText, verifyAndFilter, httpProbe } from "@mcp/generator/lean";
import { chooseScraper } from "./scraper.js";
import { selectInference } from "./select-inference.js";
import { buildInferencePayload } from "./inference-clients.js";
import { FsPersistence, installHint } from "./persistence.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const errorText = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], isError: true });

// Same TS2589 workaround the generated servers + forge-mcp use: the SDK's generic deep-instantiates over zod.
type Register = (
  name: string,
  config: { description?: string; inputSchema?: z.ZodRawShape },
  cb: (args: Record<string, unknown>) => Promise<ToolResult>,
) => void;

function toolSummary(tools: { name?: string; description?: string }[]): string {
  return tools.length
    ? tools.map((t) => `  - ${t?.name ?? "(unnamed)"}: ${String(t?.description ?? "").slice(0, 100)}`).join("\n")
    : "  (no tools)";
}

/**
 * Validate a caller-supplied URL at the tool boundary (defense-in-depth; codegen also sanitizes). Enforces an
 * http(s)-only scheme and rejects line terminators / control chars (which a crafted page could try to smuggle
 * in to break out of the generated server's header comment). Returns the trimmed URL or an error message.
 */
async function validateUrl(raw: unknown): Promise<{ ok: true; url: string } | { ok: false; msg: string }> {
  const url = String(raw ?? "").trim();
  if (!url) return { ok: false, msg: "url is required (e.g. https://rubygems.org)." };
  for (const ch of url) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) {
      return { ok: false, msg: "url must not contain line breaks or control characters." };
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, msg: `not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, msg: `unsupported URL scheme '${parsed.protocol}' - only http and https are allowed.` };
  }
  try {
    await assertPublicHttpUrl(url, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
  } catch (err) {
    return {
      ok: false,
      msg:
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Set FORGE_ALLOW_PRIVATE_HOSTS=1 only when intentionally generating from an internal host you control.",
    };
  }
  return { ok: true, url };
}

async function validateToolTargets(tools: ToolDefinition[]): Promise<string[]> {
  const errors: string[] = [];
  for (const tool of tools) {
    if (tool.execution.kind !== "http") continue;
    try {
      await assertPublicHttpUrl(tool.execution.request.rawUrl, { allowEnv: "FORGE_ALLOW_PRIVATE_HOSTS" });
    } catch (err) {
      errors.push(`  ${tool.name}: ${err instanceof Error ? err.message : String(err)} (${tool.execution.request.rawUrl})`);
    }
  }
  return errors;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "urlmcp", version: "0.4.0" });
  const register = server.registerTool.bind(server) as unknown as Register;
  const inference = selectInference();

  // ---- HOST-AS-BRAIN PATH (the default): scrape, then let the CALLING model design the tools. ----

  register(
    "forge_scrape",
    {
      description:
        "STEP 1 of building an MCP server from a website WITHOUT any API key: scrape the URL and return its " +
        "structured analysis (page type, forms, links, candidate API endpoints, observed network, a DOM sample). " +
        "YOU (the calling model) then decide the tool set and call forge_emit_server with it. This is the " +
        "recommended path - no LLM key needed, because you are the brain (like how Playwright MCP works).",
      inputSchema: {
        url: z.string().describe("The website to analyze, e.g. https://rubygems.org"),
        legalMode: z.enum(["safe", "full_scrape"]).optional().describe("Scrape mode; default 'safe'."),
      },
    },
    async (args) => {
      const v = await validateUrl(args.url);
      if (!v.ok) return errorText(v.msg);
      const url = v.url;
      const legalMode = (typeof args.legalMode === "string" ? args.legalMode : "safe") as LegalMode;
      try {
        const { scraper, kind } = chooseScraper();
        const bundle = await scraper.capture(url, legalMode);
        const analysis = buildInferencePayload(bundle);
        // Best-effort API-contract probe: if the site PUBLISHES an OpenAPI/Swagger/GraphQL contract, hand the
        // calling model ready-made, correctly-typed ToolDefinitions it can pass straight to forge_emit_server -
        // far higher quality than designing them from the DOM. Bounded + never blocks the scrape.
        let apiTools: unknown[] = [];
        try {
          apiTools = await discoverApiSpecTools(url, httpFetchText({ timeoutMs: 4_000 }), { maxProbes: 8 });
        } catch {
          /* best-effort: a probe failure must not fail the scrape */
        }
        const apiSection = apiTools.length
          ? [
              ``,
              `DISCOVERED API-CONTRACT TOOLS (${apiTools.length}) - this site publishes a machine-readable contract.`,
              `You can pass these STRAIGHT to forge_emit_server({ url, tools: [...] }), optionally adding more:`,
              JSON.stringify(apiTools),
            ]
          : [];
        return text(
          [
            `Scraped ${url} (scraper: ${kind}).`,
            ``,
            `PAGE ANALYSIS (use this to design tools):`,
            JSON.stringify(analysis),
            ...apiSection,
            ``,
            `NEXT: design MCP tools from the above, then call forge_emit_server({ url, tools: [...] }).`,
            `Each tool must match this shape (see ToolDefinition):`,
            `  { "name": "snake_case_name", "description": "...", "inputSchema": { "type":"object", "properties": {...} },`,
            `    "execution": { "kind": "http", "request": { "method":"GET", "urlPattern":"/path", "rawUrl":"https://...", "statusCode":200, "contentType":"application/json" }, "paramMapping": {} },`,
            `    "confidence": 0.7 }`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(`forge_scrape failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  register(
    "forge_emit_server",
    {
      description:
        "STEP 2: turn tool definitions YOU designed (from forge_scrape) into a runnable MCP server on disk. " +
        "Deterministic codegen - no LLM involved. Writes the server's source + install scripts to a local " +
        "directory and returns the path plus the one command to install it into your MCP clients.",
      inputSchema: {
        url: z.string().describe("The source website these tools came from."),
        title: z.string().optional().describe("Human title for the server (defaults to the URL)."),
        tools: z.array(z.unknown()).describe("Array of ToolDefinition objects (see forge_scrape output for the shape)."),
      },
    },
    async (args) => {
      const v = await validateUrl(args.url);
      if (!v.ok) return errorText(v.msg);
      const url = v.url;
      const rawTools = Array.isArray(args.tools) ? args.tools : [];
      if (!rawTools.length) return errorText("tools is required: an array of ToolDefinition objects.");

      const valid: ToolDefinition[] = [];
      const errors: string[] = [];
      rawTools.forEach((t, i) => {
        const parsed = ToolDefinition.safeParse(t);
        if (parsed.success) valid.push(parsed.data);
        else errors.push(`  tool[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      });
      if (!valid.length) {
        return errorText(`No valid tools. Fix these and retry:\n${errors.join("\n") || "  (all tools failed validation)"}`);
      }
      const targetErrors = await validateToolTargets(valid);
      if (targetErrors.length) {
        return errorText(
          "Refusing to emit a server with private, loopback, reserved, or non-public HTTP tool targets:\n" +
            targetErrors.join("\n") +
            "\nSet FORGE_ALLOW_PRIVATE_HOSTS=1 only when intentionally generating from internal hosts you control.",
        );
      }

      try {
        const title = (typeof args.title === "string" && args.title.trim()) || url;

        // LIVE VERIFICATION (default on; FORGE_VERIFY=0 to skip): execute each idempotent GET tool against the
        // real site and drop ones returning 404/network-error/empty body, so a wrong URL template is never
        // shipped as working. Writes, browser, placeholder, and bot-blocked tools are kept. FORGE_VERIFY=0 skips.
        let toolsToEmit = valid;
        let verifyNote = "";
        if (process.env.FORGE_VERIFY !== "0") {
          try {
            const { tools: kept, dropped, report } = await verifyAndFilter(valid, httpProbe());
            if (kept.length > 0) toolsToEmit = kept; // fail open: never let verification empty the server
            verifyNote =
              `Live check: ${report.verified} verified, ${report.dead} dead, ${report.blocked} blocked, ${report.notVerifiable} not-verifiable.` +
              (dropped.length && kept.length > 0
                ? `\nDropped ${dropped.length} dead tool(s): ` + dropped.map((d) => `${d.name} (${d.reason ?? d.status})`).join(", ")
                : dropped.length && kept.length === 0
                  ? `\n(All tools failed the live check; kept for inspection - set FORGE_VERIFY=0 to skip.)`
                  : "");
          } catch {
            /* verification is best-effort; never block emitting */
          }
        }

        const persistence = new FsPersistence();
        const { serverId, version } = await persistence.nextServer(url);
        const browsing = toolsToEmit.some((t) => t.execution.kind === "browser");
        // "Use opencli when the old logic can't": in this agent-driven emit path the calling model designed the
        // tools (no capture bundle to scan), so a browser-only server with NO HTTP tools to fall back on is the
        // explicit "this needs a real browser" intent (e.g. Skyscanner) -> treat like a SPA shell and bake the
        // opencli backend. It degrades to Playwright when the bridge is down; MCP_BROWSER_BACKEND overrides.
        const httpCount = toolsToEmit.filter((t) => t.execution.kind === "http").length;
        const dynamicBackend = chooseBrowserBackend({ spaShell: browsing && httpCount === 0, networkApiCount: httpCount });
        const artifact = generateServer({ serverId, version, url, title, tools: toolsToEmit, browsing, dynamicBackend });
        const dir = await persistence.saveArtifact(artifact);
        const written = artifact.files.length;
        const entry: RegistryEntry = {
          serverId,
          url,
          title,
          tier: "auto_gen",
          confidence: aggregateConfidence(toolsToEmit.map((t) => t.confidence)),
          installCount: 0,
          lastParsedAt: new Date().toISOString(),
          status: "active",
          currentVersion: version,
        };
        await persistence.writeRegistry(entry, toolsToEmit, dir);
        const hasSh = artifact.files.some((f) => f.path === "install.sh");
        return text(
          [
            `Built MCP server "${title}" with ${toolsToEmit.length} tool(s)${errors.length ? ` (${errors.length} invalid skipped)` : ""}.`,
            verifyNote,
            `Wrote ${written} file(s) to:`,
            `  ${dir}`,
            ``,
            toolSummary(toolsToEmit),
            ``,
            `Install it into your MCP clients:`,
            `  ${installHint(dir, hasSh)}`,
            errors.length ? `\nSkipped invalid tools:\n${errors.join("\n")}` : ``,
          ].filter(Boolean).join("\n"),
        );
      } catch (err) {
        return errorText(`forge_emit_server failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ---- ONE-SHOT PATH: server-side inference (for non-agentic clients, or when you WANT a configured model). ----

  register(
    "forge_generate",
    {
      description:
        `One-shot: scrape a URL and build a runnable MCP server in a single call, using the server-side ` +
        `inference configured via FORGE_INFERENCE (currently: ${inference.label}). Prefer forge_scrape + ` +
        `forge_emit_server when you are an agent (no API key, higher quality). Use this for non-agentic clients ` +
        `or when you specifically want a configured provider/local model to do the inference.`,
      inputSchema: {
        url: z.string().describe("The website to turn into an MCP server."),
        legalMode: z.enum(["safe", "full_scrape"]).optional().describe("Scrape mode; default 'safe'."),
      },
    },
    async (args) => {
      const v = await validateUrl(args.url);
      if (!v.ok) return errorText(v.msg);
      const legalMode = (typeof args.legalMode === "string" ? args.legalMode : "safe") as LegalMode;
      // Validate (don't cast) the request against the contract - this is the only gate on legalMode's
      // full_scrape acknowledgement invariant, and gives a real error instead of a confusing downstream throw.
      const reqParsed = GenerateRequest.safeParse({
        url: v.url,
        legalMode,
        acknowledgedFullScrape: legalMode === "full_scrape",
      });
      if (!reqParsed.success) {
        return errorText(`invalid request: ${reqParsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      try {
        const { scraper } = chooseScraper();
        const persistence = new FsPersistence();
        // Sub-page + API-contract discovery (sitemap/OpenAPI/GraphQL) AND live verification, threaded into the
        // one-shot path so it matches the agent path: more tools, and dead ones execution-checked out before
        // the server is presented as working. FORGE_VERIFY=0 / FORGE_DISCOVERY=0 opt out.
        const discoverSubPages =
          process.env.FORGE_DISCOVERY === "0"
            ? undefined
            : async (pageUrl: string) => {
                try {
                  return await discoverApiSpecTools(pageUrl, httpFetchText({ timeoutMs: 4_000 }), { maxProbes: 8 });
                } catch {
                  return [];
                }
              };
        const verifyTools =
          process.env.FORGE_VERIFY === "0"
            ? undefined
            : async (tools: ToolDefinition[], _pageUrl: string): Promise<ToolDefinition[]> => {
                try {
                  const { tools: kept } = await verifyAndFilter(tools, httpProbe());
                  return kept.length > 0 ? kept : tools; // fail open: never empty the server on a verify glitch
                } catch {
                  return tools;
                }
              };
        const outcome = await generate(reqParsed.data, { scraper, inference: inference.client, persistence, discoverSubPages, verifyTools });
        const dir = persistence.dirFor(outcome.serverId) ?? "(unknown)";
        const tools = Array.isArray(outcome.artifact.tools) ? outcome.artifact.tools : [];
        const hasSh = outcome.artifact.files.some((f) => f.path === "install.sh");

        // Make a degraded inference path VISIBLE: any heuristic run (explicit, host-default, OR a fallback
        // because a requested provider's key was missing) must say so - inference.label carries the reason.
        const degraded = inference.hostBrain || inference.mode === "heuristic";
        const note = degraded
          ? `\nNote: inference used the keyless heuristic (${inference.label}). For higher-quality tools, set ` +
            `FORGE_INFERENCE to a provider/model (with its API key), or use forge_scrape + forge_emit_server.`
          : ``;

        // A broken / zero-tool result must NOT be presented as success with install instructions.
        if (outcome.status === "broken" || outcome.toolCount === 0) {
          return errorText(
            [
              `forge_generate produced NO usable tools for ${v.url} (status: ${outcome.status}).`,
              `Likely causes: the site is JS-rendered (set SCRAPER_URL to a Playwright scraper), it is bot-protected,`,
              `or inference returned nothing usable.`,
              dir !== "(unknown)" ? `Any partial files were written to: ${dir}` : ``,
              note.trim(),
            ].filter(Boolean).join("\n"),
          );
        }

        return text(
          [
            `Generated MCP server from ${v.url} using inference: ${inference.label}.`,
            `status: ${outcome.status}   tools: ${outcome.toolCount}   confidence: ${outcome.confidence.toFixed(2)}`,
            ``,
            toolSummary(tools),
            ``,
            `Wrote files to:`,
            `  ${dir}`,
            `Install it into your MCP clients:`,
            `  ${installHint(dir, hasSh)}${note}`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(`forge_generate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return server;
}
