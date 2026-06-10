# anymcp

A **self-contained** MCP server that turns any website into a runnable MCP server — entirely in-process. No
backend, no Postgres, no Redis, no Docker. One `npx`, like Playwright MCP.

It scrapes a URL, figures out the tools, and writes a runnable MCP server to disk that you can install into
your MCP clients.

> Part of the MCP Forge multi-product repo. The hosted web platform + microservices and the Chrome extension
> are separate products; **this** is the standalone, install-and-go MCP server.

---

## Install (default: no API key needed)

By default, **the brain is the model you're already running** — the agent that called the tool (Claude Code,
Codex, Cursor, …) does the inference itself, exactly like how Playwright MCP just drives a browser. So the
default config needs **no API key and no external service**:

```jsonc
{
  "mcpServers": {
    "anymcp": {
      "command": "npx",
      "args": ["-y", "anymcp"]
      // No env needed. By default inference is done by the model you're already using (host-as-brain):
      // forge_scrape returns the page, your model designs the tools, forge_emit_server writes the server.
    }
  }
}
```

Then, in your client: *"Build me an MCP server for https://rubygems.org"*. The agent calls `forge_scrape`,
designs the tools, and calls `forge_emit_server`. Done — zero config.

---

## The three tools

| Tool | LLM? | What it does |
|------|------|--------------|
| `forge_scrape` | none | Scrape a URL → structured page analysis (forms, links, candidate endpoints, network, DOM sample). **You** design the tools from it. |
| `forge_emit_server` | none | Take the tool definitions you designed → deterministic codegen → writes a runnable MCP server to disk. |
| `forge_generate` | configurable | One-shot scrape→infer→build, using a server-side model (see below). For non-agentic clients or when you *want* a specific model. |

The recommended path is `forge_scrape` + `forge_emit_server` (no key, and your agent is usually the smartest
model available). `forge_generate` exists for clients that can't do multi-step tool calls.

---

## Optional: server-side inference for `forge_generate`

If you want the server itself to do the inference, set **`FORGE_INFERENCE`**. It accepts a provider name or the
LiteLLM-style `provider/model` form (e.g. `groq/llama-3.3-70b-versatile`). Every hosted and local option below
goes through **one** OpenAI-compatible client — the standard the whole ecosystem converged on — so adding a
provider is trivial and a key uses that provider's conventional env var.

| `FORGE_INFERENCE` | Needs | Notes |
|-------------------|-------|-------|
| *(unset)* / `host` | nothing | Default. Host-as-brain via scrape+emit; `forge_generate` falls back to the keyless heuristic. |
| `heuristic` | nothing | Keyless, rule-based. No LLM, no network. |
| `openai` | `OPENAI_API_KEY` | + optional `gpt-4o-mini` default; pin with `openai/<model>`. |
| `groq` | `GROQ_API_KEY` | Fast. |
| `together` | `TOGETHER_API_KEY` | |
| `openrouter` | `OPENROUTER_API_KEY` | 300+ models behind one key. |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `mistral` | `MISTRAL_API_KEY` | |
| `fireworks` | `FIREWORKS_API_KEY` | |
| `xai` | `XAI_API_KEY` | Grok. |
| `claude` | `ANTHROPIC_API_KEY` | Native Anthropic client. |
| `gemini` | `GEMINI_API_KEY` | Native Google client. |
| `ollama` | nothing | **Fully local.** Runs against `ollama serve` (`OLLAMA_URL`, default `http://localhost:11434/v1`; `OLLAMA_MODEL`, default `llama3.1`). No key. |
| `lmstudio` | nothing | Local LM Studio (`LMSTUDIO_URL`, default `http://localhost:1234/v1`; `LMSTUDIO_MODEL`). No key. |
| `vllm` | nothing | Local vLLM (`VLLM_BASE_URL`, default `http://localhost:8000/v1`; `VLLM_MODEL`). No key. |
| `openai-compatible` | `FORGE_OPENAI_BASE_URL` | **Any** other OpenAI-compatible endpoint (a gateway, a proxy, a new provider). `FORGE_API_KEY` optional. |
| `http` | `FORGE_INFERENCE_URL` | **Bring your own logic** — POSTs the scraped page to your endpoint; you return the tool list. |

### Examples

Local model, no key, nothing leaves your machine:

```jsonc
{ "mcpServers": { "anymcp": {
  "command": "npx", "args": ["-y", "anymcp"],
  "env": { "FORGE_INFERENCE": "ollama", "OLLAMA_MODEL": "llama3.1" }
} } }
```

A hosted provider (any big one — swap the name + key):

```jsonc
{ "mcpServers": { "anymcp": {
  "command": "npx", "args": ["-y", "anymcp"],
  "env": { "FORGE_INFERENCE": "groq/llama-3.3-70b-versatile", "GROQ_API_KEY": "gsk_..." }
} } }
```

Your own inference logic (a script, a router, anything that speaks back tool JSON):

```jsonc
{ "mcpServers": { "anymcp": {
  "command": "npx", "args": ["-y", "anymcp"],
  "env": { "FORGE_INFERENCE_URL": "https://my-host/infer" }
} } }
```

Your custom endpoint receives `{ systemPrompt, url, payload, bundle }` and returns either a JSON array of
tools, `{ "tools": [...] }`, or a JSON string of the same.

---

## Other env

| Var | Default | Meaning |
|-----|---------|---------|
| `MCP_FORGE_HOME` | `~/.mcp-forge` | Where generated servers + `registry.json` are written. |
| `FORGE_BROWSER` | *(on)* | In-process stealth browser capture (renders JS + captures XHR/fetch traffic) for dynamic / bot-walled sites. Chromium auto-installs on first use. Set `0` to force the cheap static-only fetch. |
| `FORGE_NO_BROWSER_INSTALL` | *(off)* | Set `1` to never auto-download Chromium (capture stays static unless a browser is already present). |
| `SCRAPER_DISCOVERY_MODE` | `1` | Escalate to the browser even on server-rendered pages so their API traffic is captured into tools. `0` keeps the static result when it's sufficient. |
| `SCRAPER_INTERACT` | `1` | During a browser capture, scroll / submit a search / click "load more" to surface action-only XHR. |
| `MCP_BROWSER_CHANNEL` | *(unset)* | Drive your real installed Chrome (`chrome`) instead of bundled Chromium — stronger stealth. |
| `MCP_BROWSER_DRIVER` | *(unset)* | Use a stealth-patched Playwright drop-in (`patchright` / `rebrowser-playwright`, install it yourself) for hard bot walls. |
| `SCRAPER_URL` | *(unset)* | If set, use the remote Python scraper service instead of the in-process browser (its 4-tier stealth incl. Camoufox + nodriver). |
| `FORGE_MODEL` | per-provider | Override the model for the selected provider. |
| `FORGE_MAX_TOKENS` | `8192` | Max output tokens for OpenAI-compatible inference. Lower it for small-context local models. |
| `FORGE_INFERENCE_HEADERS` | *(unset)* | JSON object of extra headers for the `http` inference endpoint (e.g. auth). |
| `FORGE_FETCH_TIMEOUT_MS` | `20000` | Timeout for the built-in static page fetch. |
| `FORGE_FETCH_MAX_BYTES` | `5000000` | Max page size the built-in scraper will read (memory guard). |
| `FORGE_BROWSER_TIMEOUT_MS` | `30000` | Navigation timeout for the in-process browser capture. |
| `FORGE_INFERENCE_TIMEOUT_MS` | `60000` | Timeout for a custom (`http`) inference endpoint. |
| `FORGE_INFERENCE_RESPONSE_MAX_BYTES` | `1000000` | Max response body read from a custom (`http`) inference endpoint. |

## Develop

```bash
npm run build   # build @mcp/generator + this package
npm test        # 4 suites: provider resolution, stdio boot, emit-server e2e, full local pipeline (no key, no network)
```

## Install footprint

`npx -y anymcp` is tiny: the whole server is a single bundled file, and the only dependency is
**`playwright-core`** (the browser engine, **no bundled browsers**). Install is ~2s / ~14MB — there is **no
500MB browser download at install time**. The first time you scrape a *dynamic* site, the server downloads
**one** Chromium (~one-time, ~20-40s, progress shown in your client's logs), then caches it. Static / server-
rendered sites need no browser at all.

## Dynamic / bot-walled sites

By default the server captures with an **in-process stealth browser**: it renders client-side JS and captures
the page's XHR/fetch traffic, so it builds tools for SPAs and anti-bot-protected sites with **no backend** and
**no manual setup** — Chromium auto-installs on first use.

Stealth mirrors the generated servers (AutomationControlled off, `navigator.webdriver` stripped). For hard
walls, set `MCP_BROWSER_CHANNEL=chrome` to drive your real Chrome, or `MCP_BROWSER_DRIVER=patchright`. Set
`FORGE_BROWSER=0` to skip the browser entirely (static-only), or `FORGE_NO_BROWSER_INSTALL=1` to never
auto-download. If the browser is unavailable, capture falls back to the static fetch.

## Limitations (honest)

- The in-process browser handles most dynamic sites, but the hardest anti-bot walls also score IP reputation:
  from a datacenter IP some sites still block regardless of stealth. Use `MCP_BROWSER_CHANNEL=chrome` /
  `MCP_BROWSER_DRIVER=patchright`, or point `SCRAPER_URL` at the full Python scraper (4-tier, Camoufox + nodriver).
- `forge_generate` quality depends on the model you pick; the keyless heuristic is a floor, not a ceiling.
