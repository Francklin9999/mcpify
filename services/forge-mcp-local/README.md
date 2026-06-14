# urlmcp

A **self-contained** MCP server that turns any website into a runnable MCP server — entirely in-process. No
backend, no Postgres, no Redis, no Docker. One `npx`, like Playwright MCP.

It scrapes a URL, figures out the tools, and writes a runnable MCP server to disk that you can install into
your MCP clients.

> This package **is** the repo's product. See the [root README](../../README.md) for the project overview;
> this file is the deep reference for every environment variable and behavior.

---

## Install (default: no API key needed)

By default, **the brain is the model you're already running** — the agent that called the tool (Claude Code,
Codex, Cursor, …) does the inference itself, exactly like how Playwright MCP just drives a browser. So the
default config needs **no API key and no external service**:

```jsonc
{
  "mcpServers": {
    "urlmcp": {
      "command": "npx",
      "args": ["-y", "urlmcp"]
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
{ "mcpServers": { "urlmcp": {
  "command": "npx", "args": ["-y", "urlmcp"],
  "env": { "FORGE_INFERENCE": "ollama", "OLLAMA_MODEL": "llama3.1" }
} } }
```

A hosted provider (any big one — swap the name + key):

```jsonc
{ "mcpServers": { "urlmcp": {
  "command": "npx", "args": ["-y", "urlmcp"],
  "env": { "FORGE_INFERENCE": "groq/llama-3.3-70b-versatile", "GROQ_API_KEY": "gsk_..." }
} } }
```

Your own inference logic (a script, a router, anything that speaks back tool JSON):

```jsonc
{ "mcpServers": { "urlmcp": {
  "command": "npx", "args": ["-y", "urlmcp"],
  "env": { "FORGE_INFERENCE_URL": "https://my-host/infer" }
} } }
```

Your custom endpoint receives `{ systemPrompt, url, payload, bundle }` and returns either a JSON array of
tools, `{ "tools": [...] }`, or a JSON string of the same.

---

## Other env

| Var | Default | Meaning |
|-----|---------|---------|
| `URLMCP_HOME` | `~/.urlmcp` | Where generated servers + `registry.json` are written. (Legacy `MCP_FORGE_HOME` / `~/.mcp-forge` from before the rename are still honored.) |
| `FORGE_ROBOTS` | *(prompt)* | Robots policy: `respect` obeys the site's `robots.txt` (refuses Disallowed paths); `full` ignores it (sites you own / are authorized for). Unset = the user is prompted before each scrape, defaulting to `respect`. Also settable per-call via the `robots` tool argument. |
| `FORGE_ROBOTS_TIMEOUT_MS` | `6000` | Timeout for the `robots.txt` fetch in respect mode (fail-open: an unreachable `robots.txt` does not block). |
| `FORGE_BROWSER` | *(on)* | In-process stealth browser capture (renders JS + captures XHR/fetch traffic) for dynamic / bot-walled sites. Chromium auto-installs on first use. Set `0` to force the cheap static-only fetch. |
| `FORGE_NO_BROWSER_INSTALL` | *(off)* | Set `1` to never auto-download Chromium (capture stays static unless a browser is already present). |
| `SCRAPER_DISCOVERY_MODE` | `1` | Escalate to the browser even on server-rendered pages so their API traffic is captured into tools. `0` keeps the static result when it's sufficient. |
| `SCRAPER_INTERACT` | `1` | During a browser capture, scroll / submit a search / click "load more" to surface action-only XHR. |
| `FORGE_BROWSER_ESCALATE` | `1` | Auto-climb the stealth ladder (real Chrome → stealth driver → headful) when a capture looks blocked. `0` = single attempt. |
| `FORGE_AUTH_HANDOFF` | `1` | After every stealth rung still hits a sign-in/CAPTCHA wall, open a VISIBLE browser, tell the user, and wait for them to sign in / solve it — then continue capturing the authenticated page in the same session. Needs a display. `0` disables. |
| `FORGE_AUTH_HANDOFF_TIMEOUT_MS` | `300000` | How long the human handoff waits (5 min) before capturing the page as-is. |
| `FORGE_AUTH_POLL_MS` | `2500` | How often the handoff re-checks whether the wall has been cleared. |
| `FORGE_BROWSER_PROFILE` | *(off)* | Reuse your **real signed-in** Chrome/Edge profile so capture opens already logged into Gmail/Google/etc. `clone` (recommended) copies your profile once into `~/.urlmcp/browser-profile/<channel>` and drives that — your everyday browser stays untouched and unlocked. `real` drives your live profile in place (quit Chrome first; it locks the profile). An absolute path is used as the user-data-dir directly. Needs a real channel (`MCP_BROWSER_CHANNEL`/auto-detect). *Note: driving a Google-signed-in profile via automation can trigger account-security checks.* |
| `FORGE_BROWSER_PROFILE_NAME` | `Default` | Which profile sub-directory to use (e.g. `Profile 1`). |
| `FORGE_BROWSER_PROFILE_SRC` | *(auto)* | Override the source `User Data` dir to clone/drive (default: your OS Chrome/Edge location). |
| `FORGE_BROWSER_PROFILE_REFRESH` | `0` | `1` re-copies the clone from your live profile (otherwise cloned once and reused). |
| `FORGE_USE_REAL_BROWSER` | *(on)* | By default, when your real Chrome/Edge + a display are present, capture auto-opens a signed-in clone of your profile with a debug port (logged-in session). Set `0` to always use the managed browser instead. Overridden by an explicit `FORGE_BROWSER_CDP`. |
| `FORGE_CRAWL` | *(on)* | Site-aware capture: a given link first captures the **base domain**, explores a few same-origin pages, and includes the **given path**, merging their endpoints into one bundle. Set `0` for single-page capture. |
| `FORGE_CRAWL_MAX_PAGES` | `4` | Total pages captured during a crawl (root + given + explored). |
| `FORGE_CRAWL_BUDGET_MS` | `90000` | Stop exploring once this much wall-clock has elapsed. |
| `FORGE_CRAWL_ROBOTS` | `1` | Check `robots.txt` for each auto-discovered page before exploring it (fail-open). The root + the given path are always captured. |
| `FORGE_BROWSER_CDP` | *(off)* | **Attach** to a browser you're already running, over CDP, instead of launching a fresh one — captures in your real, signed-in session. A port/endpoint (`9222`, `host:9222`, `http://127.0.0.1:9222`, or a `ws://` DevTools URL) attaches to a Chrome you started with `--remote-debugging-port` (or another CDP browser). `launch` makes urlmcp start your real Chrome/Edge with a debugging port (pair with `FORGE_BROWSER_PROFILE=clone` to launch it already signed in). See **Logged-in sites** below. |
| `FORGE_BROWSER_CDP_PORT` | `47800` | Port used by `FORGE_BROWSER_CDP=launch` when starting your real browser. |
| `FORGE_BROWSER_BACKEND` | *(off)* | Set `extension` to route capture through the **urlmcp Chrome extension** running in your everyday browser (no flags, no relaunch). Run `npx urlmcp install-extension` first. Degrades to the normal browser ladder if the extension isn't connected. |
| `FORGE_EXT_PORT` | `47900` | Loopback port for the extension bridge (must match the value baked into the extension at `install-extension`). |
| `FORGE_EXT_WAIT_MS` | `20000` | How long capture waits for the extension to connect before degrading to the managed browser. |
| `MCP_BROWSER_CHANNEL` | *(auto)* | Force a real-browser channel (`chrome` / `msedge`). Auto-detected from your installed browsers when unset. |
| `MCP_BROWSER_DRIVER` | *(auto)* | Force a stealth-patched Playwright drop-in (`patchright` / `rebrowser-playwright`). `rebrowser-playwright-core` ships as an optional dependency and is used automatically. |
| `MCP_BROWSER_HEADLESS` | `1` | Set `0` to always run headful (strongest stealth; needs a display). The ladder also goes headful on its own when escalating. |
| `MCP_BROWSER_PATH` | *(unset)* | Absolute path to a specific browser executable to drive. |
| `MCP_BROWSER_TZ` | `America/New_York` | Timezone presented to pages during capture. |
| `SCRAPER_URL` | *(unset)* | If set, use a remote Playwright scraper service instead of the in-process browser. |
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
npm run build            # build @mcp/generator + this package
npm test                 # provider resolution, stdio boot, emit-server e2e, full local pipeline,
                         # dynamic-site backward-compat (captured XHR -> tools) + RCE/SSRF security (no key, no network)
npm run test:live-browser # drives a REAL Chromium against a local SPA: JS render + XHR capture + dynamic->tool
```

The dynamic-website backward-compat suite (`test/dynamic-backcompat.mjs`) is hermetic and always runs — it pins
"captured SPA/AJAX traffic still becomes tools" against real captured-site fixtures. The live browser test
(`test/dynamic-live.mjs`) self-skips unless `FORGE_TEST_LIVE_BROWSER=1`, so `npm test` stays fast and offline.

## Install footprint

`npx -y urlmcp` is tiny: the whole server is a single bundled file, and the only dependency is
**`playwright-core`** (the browser engine, **no bundled browsers**). Install is ~2s / ~14MB — there is **no
500MB browser download at install time**. The first time you scrape a *dynamic* site, the server downloads
**one** Chromium (~one-time, ~20-40s, progress shown in your client's logs), then caches it. Static / server-
rendered sites need no browser at all.

## Logged-in sites (LinkedIn, Gmail, X, ...)

For sites that only work when you're signed in, urlmcp captures **in your real, already-authenticated browser
session** instead of a fresh, logged-into-nothing one. **By default**, when your real Chrome/Edge is installed and a
display is available, urlmcp automatically opens a signed-in clone of your profile with a debugging port and captures
there — no configuration needed. If no real browser (or no display) is available it falls back to the managed stealth
browser. Set `FORGE_USE_REAL_BROWSER=0` to always use the managed browser. The paths, in detail:

| Path | Turn on with | What happens | Best when |
|------|--------------|--------------|-----------|
| **Auto (default)** | *(nothing — on by default)* | When your real Chrome/Edge + a display are present, urlmcp opens a signed-in clone of your profile with a debug port and captures there; otherwise falls back to the managed browser. | The common case — you just want logged-in capture to work. Disable with `FORGE_USE_REAL_BROWSER=0`. |
| **Attach over CDP** | `FORGE_BROWSER_CDP=9222` | You start Chrome with `--remote-debugging-port=9222`; urlmcp attaches to that **live** browser, captures in its session, and leaves it open. No copy, no lock, minimal bot-flagging. | You already run Chrome with a debug port, or want to attach to another CDP browser (Comet, browseros, …). |
| **Launch + attach** | `FORGE_BROWSER_CDP=launch FORGE_BROWSER_PROFILE=clone` | urlmcp opens your real Chrome (signed in, via a one-time profile clone) with a debugging port and drives it, leaving the window open for you. | You want one command, no manual flags, and the launched browser already logged in. |
| **Browser extension** | `npx urlmcp install-extension`, then `FORGE_BROWSER_BACKEND=extension` | A tiny extension runs inside your **everyday** Chrome and captures the page in your current session via `chrome.debugger` — no relaunch, no flags, no profile copy. | Your normal browser is already open and signed in and you don't want to restart it. |
| **Profile reuse** | `FORGE_BROWSER_PROFILE=clone` | urlmcp launches its own (managed) browser against a copy of your signed-in profile. | You want a self-contained managed launch that's already logged in. |
| **Human handoff** | *(on by default)* | If automated stealth still hits a sign-in/CAPTCHA wall, a visible window opens and waits for you to sign in, then continues. | Anything else — the catch-all fallback. |

**Attaching** to a browser you (or another tool) already run is the lightest and least-detectable option — it *is*
your real browser, so there's no profile to copy or lock and far less to trip account-security checks. The
**extension** is the same idea without needing to start Chrome with a flag (Chrome will show *"urlmcp connector
started debugging this browser"* while a capture runs — that's expected). To start Chrome with a debug port yourself:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
# Linux
google-chrome --remote-debugging-port=9222
# then run urlmcp with FORGE_BROWSER_CDP=9222
```

**Sign-in / CAPTCHA pause.** On *every* logged-in path (attach, launch, extension, managed) if a capture lands on a
sign-in or CAPTCHA wall, urlmcp **pauses and waits for you to complete it** in the open window — showing a banner —
then continues capturing the now-authenticated page in the same session (up to `FORGE_AUTH_HANDOFF_TIMEOUT_MS`,
`FORGE_AUTH_HANDOFF=0` disables). The pause only fires on a real wall (a login page or a *thin* CAPTCHA page), so an
already-logged-in content page is never interrupted.

**Your password is never captured.** While you sign in, urlmcp only ever checks *whether the wall is gone* — it never
reads what you type. Captured DOM has credential input values (password / OTP / card / security-code fields) redacted
to `__redacted__`, JSON request bodies have secret-named fields scrubbed, and login forms (URL-encoded posts) aren't
recorded at all.

Everything stays on your machine: the extension bridge binds to `127.0.0.1` only, and no credentials are ever sent
anywhere. Driving a Google-signed-in session via automation can still trip account-security checks — attaching to
your real browser minimizes that, but it's the same account.

## Site-aware crawl

Given a link, urlmcp doesn't just capture that one page — it **starts at the base domain**, captures it (which also
warms the logged-in session and surfaces the site's own links), **explores a few same-origin pages**, and **always
includes the complete path you gave it**. Every page's XHR/fetch endpoints are merged into one bundle, so the
generated tools cover the site, not just the landing page. Cross-origin links, assets, and sign-out/login links are
never followed. Bounded by `FORGE_CRAWL_MAX_PAGES` (default 4) and `FORGE_CRAWL_BUDGET_MS` (default 90s); set
`FORGE_CRAWL=0` for old single-page behavior.

## Dynamic / bot-walled sites

The server captures with an **in-process stealth browser** that renders client-side JS and captures the page's
XHR/fetch traffic — so it builds tools for SPAs and anti-bot-protected sites with **no backend** and **no manual
setup**. The full high-stealth engine is baked in and runs **automatically**:

1. **Real-browser fingerprint** — `navigator.webdriver` stripped, `--enable-automation` removed,
   AutomationControlled off, `plugins`/`languages`/WebGL-vendor/permissions patched, clean (non-Headless) UA.
2. **Auto-prefers your real Chrome / Edge** when installed (driven via a Playwright channel — strongest
   fingerprint, no download); falls back to bundled Chromium.
3. **Bundled CDP-stealth driver** — `rebrowser-playwright-core` (optional dependency, no extra browser download)
   patches leaks plain Playwright can't (`Runtime.enable`, etc.) and is used automatically when present.
4. **Auto-escalation** — a cheap headless attempt first; if the render looks blocked (CAPTCHA / challenge /
   empty shell) it climbs real Chrome → stealth driver → **headful** and keeps the best result.

This cracks Amazon / Skyscanner / Booking-class sites out of the box on a normal desktop. Force any rung with
`MCP_BROWSER_CHANNEL` / `MCP_BROWSER_DRIVER` / `MCP_BROWSER_HEADLESS=0`; disable climbing with
`FORGE_BROWSER_ESCALATE=0`; skip the browser with `FORGE_BROWSER=0`. If no browser is available, capture falls
back to the static fetch.

## Limitations (honest)

- The hardest anti-bot walls also score IP reputation. From a pure datacenter IP **with no display** (a headless
  server — so the headful rung can't run), the very hardest sites can still block. On a normal desktop the
  headful escalation handles them; otherwise point `SCRAPER_URL` at an even heavier scraper.
- `forge_generate` quality depends on the model you pick; the keyless heuristic is a floor, not a ceiling.
