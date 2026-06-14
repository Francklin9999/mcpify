# urlmcp

**Turn any website into a runnable MCP server — in one `npx`, with no backend.**

`urlmcp` is a self-contained [Model Context Protocol](https://modelcontextprotocol.io) server. Point it at a
URL; it scrapes the page, figures out the useful tools (search, lookups, list endpoints, actions), and writes a
runnable MCP server to disk that you can install into Claude, Cursor, VS Code, or any MCP client.

No Postgres, no Redis, no Docker, no API key required. It runs in-process like Playwright MCP — a single bundled
file whose only dependency is a headless browser engine.

```jsonc
{
  "mcpServers": {
    "urlmcp": {
      "command": "npx",
      "args": ["-y", "urlmcp"]
    }
  }
}
```

Then ask your agent: *"Build me an MCP server for https://rubygems.org."*

---

## How it works

By default the **brain is the model you're already running**. The agent that called the tool (Claude Code,
Cursor, …) does the inference itself — exactly like Playwright MCP just drives a browser. So the default config
needs **no API key and no external service**.

The pipeline is three tools:

| Tool | Needs an LLM? | What it does |
|------|---------------|--------------|
| `forge_scrape` | No | Scrape a URL → structured page analysis (forms, links, candidate endpoints, captured XHR/fetch traffic, DOM sample). |
| `forge_emit_server` | No | Take the tool definitions your agent designed → deterministic codegen → writes a runnable MCP server to disk. |
| `forge_generate` | Configurable | One-shot scrape → infer → build, using a server-side model. For non-agentic clients or when you want a specific model. |

The recommended path is **`forge_scrape` → (your agent designs tools) → `forge_emit_server`**: no key, and your
agent is usually the smartest model in the room. `forge_generate` exists for clients that can't do multi-step
tool calls.

Generated servers are written to `~/.urlmcp/servers/<name>/` with an `install.sh` / `install.ps1` and a
`mcp-register.mjs` helper, so they build and register into your MCP client in one step.

---

## Quickstart

1. Add the config block above to your MCP client.
2. Ask: *"Make an MCP server for https://news.ycombinator.com and install it."*
3. Your agent calls `forge_scrape`, designs the tools, calls `forge_emit_server`. The new server lands in
   `~/.urlmcp/servers/`.
4. Run its `install.sh` (the agent can do this for you) and the new server appears in your client.

No keys, no services. Static and server-rendered sites need no browser; the first time you scrape a *dynamic*
site, a single Chromium downloads automatically (one-time, ~20–40s) and is cached.

---

## Dynamic & bot-walled sites

`urlmcp` captures with an **in-process stealth browser** — it renders client-side JS and captures the page's
XHR/fetch traffic, so it builds real tools for SPAs and anti-bot-protected sites with no backend and no setup.
The full high-stealth engine is baked in and **everything is automatic**:

- **Real fingerprint:** `navigator.webdriver` stripped, `--enable-automation` removed, AutomationControlled off,
  and `plugins` / `languages` / WebGL vendor / permissions patched, with a clean (non-"HeadlessChrome") UA.
- **Real browser first.** When Chrome/Edge and a display are present, it captures in a signed-in profile clone or
  attached CDP session — the strongest fingerprint, because it is your browser.
- **Bundled CDP-stealth driver.** Ships `rebrowser-playwright-core` (an optional dependency, no extra browser
  download) which patches the leaks plain Playwright can't, e.g. `Runtime.enable`.
- **Single max-stealth fallback.** If the real-browser path is not available, it makes one strongest managed
  attempt: CDP-stealth driver, real Chrome/Edge channel when installed, headful whenever a display exists, and
  headless only on a display-less server.

This combination cracks Amazon, Skyscanner, Booking, and similar anti-bot sites out of the box on a normal
desktop (where a display is available for the headed browser).

**JSON POST APIs (YouTube, LinkedIn, GraphQL).** Modern apps talk to their backend with `POST` + a JSON body
(YouTube's InnerTube, LinkedIn's Voyager, Algolia, GraphQL). `urlmcp` captures that request body — even when the
browser **gzip/brotli-compresses** it — and turns the call into a tool by **replaying the real request**: the
fixed boilerplate the API requires (a big `context` object, client info) is kept intact, and only the *variable*
fields (`query`, `videoId`, a continuation cursor…) are exposed as tool inputs. So a YouTube capture yields a
working `search` tool you call with just `{ "query": "lofi" }`, not a broken empty POST. Secrets in bodies are
redacted before anything is written to disk.

Overrides (rarely needed): `MCP_BROWSER_CHANNEL=chrome|msedge` (force a channel), `MCP_BROWSER_DRIVER=patchright`
(force a specific stealth driver), `MCP_BROWSER_HEADLESS=0` (always headful), `FORGE_USE_REAL_BROWSER=0` (skip the
real-browser default), `FORGE_BROWSER=0` (skip the browser — static-only).

> **Honest caveat:** the hardest walls also score IP reputation. From a pure datacenter IP with no display (a
> headless server, so no headed handoff), the very hardest sites can still block. On a normal desktop, or by
> pointing `SCRAPER_URL` at an even heavier scraper, those are handled too.

### Sites that need sign-in or a CAPTCHA (human handoff)

Some sites can't be passed by any automated stealth — they need a real login, or a CAPTCHA only a person can
solve. This covers password forms **and** the "sign in to continue / join to view" interstitials that
LinkedIn, X, Instagram, and Reddit show logged-out users. When max stealth still hits such a wall,
urlmcp opens a **visible browser window**, prints what to do, and **waits for you**:

```
[urlmcp] ===================== ACTION NEEDED =====================
[urlmcp] https://example.com is behind a sign-in / CAPTCHA wall that automated stealth couldn't pass.
[urlmcp] A browser window is open — please SIGN IN or SOLVE THE CAPTCHA there.
[urlmcp] urlmcp will continue automatically once you're through (waiting up to 5 min).
```

Sign in / solve the challenge in that window. The moment the wall is gone, urlmcp **continues in the same
(still-stealthy) session** — so it captures the authenticated page *and* the API calls that only fire after
login. The handoff is the last resort after the automated capture attempt.

Needs a display (the window is headful), so it runs on a desktop, not a headless server. On by default; disable
with **`FORGE_AUTH_HANDOFF=0`**, change the wait with **`FORGE_AUTH_HANDOFF_TIMEOUT_MS`** (default `300000`).

---

## robots.txt: respect or full mode

Before scraping a site, urlmcp asks **you** how to treat the site's `robots.txt`:

- **Respect** *(recommended, default)* — obey `robots.txt`; refuse to scrape a path the site Disallows.
- **Full mode** — ignore `robots.txt` and scrape anyway. **Only for sites you own or are authorized to access** —
  you are responsible for that use.

If your MCP client supports prompts (elicitation), urlmcp pops the choice automatically each time. If it
doesn't, the calling model asks you and passes the answer as the `robots` argument (`"respect"` / `"full"`).
To skip the prompt entirely, pass `robots` explicitly or set **`FORGE_ROBOTS=respect|full`** in the server env.
A declined prompt always falls back to *respect* — urlmcp never silently ignores `robots.txt`.

---

## Optional: server-side inference for `forge_generate`

Set **`FORGE_INFERENCE`** to make the server itself do inference. It accepts a provider name or the LiteLLM-style
`provider/model` form (e.g. `groq/llama-3.3-70b-versatile`). Hosted and local options all go through one
OpenAI-compatible client, so a key just uses that provider's conventional env var.

| `FORGE_INFERENCE` | Needs | Notes |
|-------------------|-------|-------|
| *(unset)* / `host` | nothing | **Default.** Host-as-brain; `forge_generate` falls back to the keyless heuristic. |
| `heuristic` | nothing | Keyless, rule-based. No LLM, no network. |
| `openai` | `OPENAI_API_KEY` | Pin a model with `openai/<model>`. |
| `claude` | `ANTHROPIC_API_KEY` | Native Anthropic client. |
| `gemini` | `GEMINI_API_KEY` | Native Google client. |
| `groq` / `together` / `openrouter` / `deepseek` / `mistral` / `fireworks` / `xai` | that provider's `*_API_KEY` | All OpenAI-compatible. |
| `ollama` / `lmstudio` / `vllm` | nothing | **Fully local.** Runs against your local server; no key, nothing leaves your machine. |
| `openai-compatible` | `FORGE_OPENAI_BASE_URL` | Any other OpenAI-compatible endpoint. `FORGE_API_KEY` optional. |
| `http` | `FORGE_INFERENCE_URL` | **Bring your own logic** — POSTs the scraped page to your endpoint; you return the tool list. |

```jsonc
// Fully local, no key, nothing leaves your machine:
{ "mcpServers": { "urlmcp": {
  "command": "npx", "args": ["-y", "urlmcp"],
  "env": { "FORGE_INFERENCE": "ollama", "OLLAMA_MODEL": "llama3.1" }
} } }
```

```jsonc
// A hosted provider — swap the name + key:
{ "mcpServers": { "urlmcp": {
  "command": "npx", "args": ["-y", "urlmcp"],
  "env": { "FORGE_INFERENCE": "groq/llama-3.3-70b-versatile", "GROQ_API_KEY": "gsk_..." }
} } }
```

---

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `FORGE_INFERENCE` | `host` | Server-side inference provider for `forge_generate` (see table above). |
| `FORGE_MODEL` | per-provider | Override the model for the selected provider. |
| `URLMCP_HOME` | `~/.urlmcp` | Where generated servers + `registry.json` are written. (Legacy `MCP_FORGE_HOME` / `~/.mcp-forge` still honored.) |
| `FORGE_ROBOTS` | *(prompt)* | Robots policy for scraping: `respect` obeys the site's `robots.txt`; `full` ignores it. When unset, the user is prompted before each scrape (and it defaults to `respect`). |
| `FORGE_BROWSER` | *(on)* | In-process stealth browser capture for dynamic sites. Set `0` to force static-only fetch. |
| `FORGE_NO_BROWSER_INSTALL` | *(off)* | Set `1` to never auto-download Chromium. |
| `SCRAPER_DISCOVERY_MODE` | `1` | Escalate to the browser even on server-rendered pages to capture their API traffic as tools. |
| `SCRAPER_INTERACT` | `1` | During capture, scroll / search / click "load more" to surface action-only XHR. |
| `MCP_BROWSER_CHANNEL` | *(auto)* | Force a real-browser channel (`chrome` / `msedge`). Auto-detected when unset. |
| `MCP_BROWSER_DRIVER` | *(auto)* | Force a stealth driver (`patchright` / `rebrowser-playwright`). `rebrowser-playwright-core` ships by default. |
| `MCP_BROWSER_HEADLESS` | *(auto)* | Max stealth runs headful when a display exists; set `1` to force headless or `0` to force headful. |
| `FORGE_USE_REAL_BROWSER` | *(on)* | Prefer a real Chrome/Edge signed-in profile clone or CDP attach when available. Set `0` to use the managed max-stealth browser directly. |
| `FORGE_AUTH_HANDOFF` | `1` | When max stealth still hits a sign-in/CAPTCHA wall, open a visible browser and wait for you to clear it (needs a display). Set `0` to disable. |
| `FORGE_AUTH_HANDOFF_TIMEOUT_MS` | `300000` | How long the human handoff waits for you to sign in / solve the CAPTCHA. |
| `SCRAPER_URL` | *(unset)* | Use a remote Playwright scraper service instead of the in-process browser. |
| `FORGE_MAX_TOKENS` | `8192` | Max output tokens for OpenAI-compatible inference. |
| `FORGE_FETCH_TIMEOUT_MS` | `20000` | Timeout for the built-in static page fetch. |
| `FORGE_BROWSER_TIMEOUT_MS` | `30000` | Navigation timeout for the in-process browser capture. |

The full list (custom inference headers, byte limits, local-model URLs) is in
[`services/forge-mcp-local/README.md`](services/forge-mcp-local/README.md).

---

## Install footprint

`npx -y urlmcp` is tiny: the server is a single bundled file and the only runtime dependency is
**`playwright-core`** (the browser engine — **no bundled browsers**). Install is roughly **2s / 14MB**; there is
no 500MB browser download at install time. Chromium downloads lazily, once, on the first dynamic scrape.

---

## Repository layout

This repo builds and publishes the single `urlmcp` package. It's a small npm workspace:

```
services/forge-mcp-local/   the published `urlmcp` server (stdio MCP, the three tools, in-process scraper)
services/generator/         core pipeline: scrape analysis + tool inference + deterministic codegen
packages/types/             shared zod contracts
scripts/opencli-bridge.mjs  optional bridge for driving a user's real Chrome (opencli backend)
docs/                       design notes
```

`forge-mcp-local` bundles `generator` and `types` into one file via esbuild, so the published package has no
workspace dependencies at runtime.

---

## Develop

```bash
npm install        # install the three workspaces
npm run build      # build generator + types, bundle the server to dist/main.bundle.mjs
npm test           # run the server's test suites (no key, no network) — incl. dynamic-site backward-compat
```

The dynamic-website pipeline (render JS → capture XHR → build tools) has two guards: a hermetic backward-compat
suite that always runs against real captured-site fixtures, and a live test that drives a real browser against a
local SPA (`npm run test:live-browser --workspace=urlmcp`, or set `FORGE_TEST_LIVE_BROWSER=1`).

Run the bundled server directly over stdio:

```bash
npm start          # node services/forge-mcp-local/dist/main.bundle.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for
reporting vulnerabilities.

---

## License

[MIT](LICENSE) © Franck Fongang
