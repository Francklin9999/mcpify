# OpenCLI browser backend (real logged-in Chrome)

For dynamic, JS-only, and bot-hardened sites — flight search (Skyscanner), booking sites, anything behind
Cloudflare/PerimeterX, or anything that needs your logged-in session — MCP Forge can drive **your real
Chrome** instead of a bundled headless Chromium.

This is powered by [opencli](https://github.com/jackwener/opencli), which exposes your browser through a local
**Browser Bridge** and a `opencli browser <session> <command>` CLI. Every generated server that ships the
`browser_*` toolkit can use it.

## Why

The default backend (`PlaywrightBrowsing`) launches a bundled headless Chromium. That fails on two large
classes of site:

- **JS-only SPAs** — the static/headless capture sees an empty `<div id="root">` shell (Skyscanner's homepage
  returns exactly this), so there is nothing to read and no API to wire HTTP tools to.
- **Bot-hardened sites** — anti-bot vendors fingerprint and block headless Chromium outright.

opencli sidesteps both: it is your *real* Chrome (real fingerprint, real cookies, real login), so the page
renders fully, anti-bot does not fire, and tools run as you.

## One-time setup

```bash
# 1. install opencli
npm i -g @jackwener/opencli

# 2. add the "Browser Bridge" extension from the Chrome Web Store, then confirm the bridge is connected:
opencli doctor

# 3. (optional) bind a specific logged-in tab so tools run in it:
#    open the tab in Chrome, then:
opencli browser mcp-<site-slug> bind
```

`opencli doctor` must report the bridge connected before any `browser_*` tool will work.

## Turning it on

Two ways — both end up calling `createBrowsing()` in the generated `server.ts`:

1. **Per-run override (works on ANY existing generated browser server, no regen):**

   ```bash
   MCP_BROWSER_BACKEND=opencli node server.js
   ```

   In an MCP client, add it to the server entry's `env`:

   ```json
   "skyscanner-net": {
     "type": "stdio",
     "command": "/usr/local/bin/node",
     "args": ["/path/to/server.js"],
     "env": { "MCP_BROWSER_BACKEND": "opencli" }
   }
   ```

2. **Baked default (automatic):** when Forge generates a server from a site it detects as dynamic / bot-walled
   (`chooseBrowserBackend()` in `services/generator/src/opencli-backend.ts`), it bakes
   `DEFAULT_BROWSER_BACKEND = "opencli"` into the server. `MCP_BROWSER_BACKEND` still overrides it, so you can
   always force `playwright` back.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MCP_BROWSER_BACKEND` | baked default (usually `playwright`) | `opencli` to drive real Chrome; `playwright` for bundled Chromium |
| `MCP_OPENCLI_BIN` | `opencli` | path to the opencli binary if not on `PATH` |
| `MCP_OPENCLI_SESSION` | `mcp-<site-slug>` | opencli session name; reuse the same name to keep one tab/state alive |
| `MCP_OPENCLI_TIMEOUT_MS` | `60000` | per-command timeout |

## How the tools map

The generated `browser_*` toolkit maps 1:1 onto opencli (verified against opencli v1.8.2):

| MCP tool | opencli command |
|---|---|
| `browser_navigate <url>` | `browser <session> open <url>` |
| `browser_snapshot` | `browser <session> state` (passed through verbatim — `[N]` indices) |
| `browser_click <ref>` | `browser <session> click <ref>` (`<ref>` = the `[N]` from the snapshot, or a CSS selector) |
| `browser_type <ref> <text>` | `browser <session> type <ref> <text>` (+ `keys Enter` when `submit`) |
| `browser_select_option` | `browser <session> select <ref> <option>` |
| `browser_press_key` | `browser <session> keys <key>` |
| `browser_back` | `browser <session> back` |
| `browser_read_page` / `browser_extract` | `browser <session> extract` |

## Stealth bridge (avoid false bot flags / CAPTCHAs)

Anti-bot vendors (PerimeterX/HUMAN on Skyscanner, Cloudflare, DataDome) flag the *automation* signals a
CDP-driven browser leaks — chiefly `navigator.webdriver === true`, an empty plugin/MIME list, missing
`window.chrome`, and a headless WebGL fingerprint. `scripts/opencli-bridge.mjs` brings the bridge up with that
hardening so opencli drives **your own** Chrome without being mistaken for a bot:

```bash
node scripts/opencli-bridge.mjs                 # persistent profile at ~/.opencli-bridge/profile
node scripts/opencli-bridge.mjs --profile ~/my-warm-profile --url https://www.skyscanner.net/
node scripts/opencli-bridge.mjs --no-stealth    # bridge only, no fingerprint patches
```

What it does:

1. **Stealth launch flags** — `--disable-blink-features=AutomationControlled` (drops `navigator.webdriver`),
   `--silent-debugger-extension-api` (hides the "a debugger is attached" banner/signal), plus a realistic
   `--lang`/`--window-size`.
2. **A stealth content-script extension** (`scripts/stealth-extension/`) that, at `document_start` in the main
   world, forces `navigator.webdriver=false`, populates `navigator.plugins`/`languages`, restores
   `window.chrome`, spoofs the WebGL vendor/renderer, and fixes the notifications-permission inconsistency.
3. **A persistent profile** so a one-time challenge solve / login banks **clearance cookies** that stick across
   runs — the single biggest lever against PerimeterX.
4. Loads the opencli bridge extension + the stealth extension over the CDP pipe and verifies
   `navigator.webdriver === false` on startup.

**Verified (2026-06-04):** with the stealth bridge, `https://www.skyscanner.net/` loads its real homepage and
the full flight-search form (origin/destination inputs, trip-type, date controls — 129 interactive elements)
**with no PerimeterX CAPTCHA**, where the plain bridge on a cold profile hit *"Are you a person or a robot?"*.
Self-check reported `{webdriver:false, plugins:5, langs:["en-US","en"], chrome:true}`.

**Honest limits.** This is fingerprint hygiene for a real browser, not a CAPTCHA solver. It removes the easy
automation tells; it does **not** defeat behavioral analysis (mouse/timing) or IP reputation. From a flagged
datacenter IP, or a brand-new profile under heavy load, a vendor may still challenge — the durable answers are
a **warm profile** (solve once; clearance is banked) and/or a residential IP. Don't use this to violate a
site's terms.

## Limitations / status

- Requires opencli + a running Chrome + the Browser Bridge extension. An opencli-backed server is **not** a
  self-contained `npx` server — that is the deliberate trade for sites a headless browser cannot handle.
- `--load-extension` is ignored by Chrome 137+; the launcher loads extensions via CDP `Extensions.loadUnpacked`
  over `--remote-debugging-pipe` + `--enable-unsafe-extension-debugging`, and must stay alive holding the pipe.
- The opencli Browser Bridge extension is fetched from the GitHub release (`opencli-extension-*.zip`); it is
  **not** in the npm package. The launcher downloads + caches it under `~/.opencli-bridge/`.
- Discovery upgrade (not yet wired): `opencli browser <s> analyze <url>` classifies the anti-bot vendor and
  surfaces real-data API candidates, and `network` captures real XHRs from the logged-in session — a future
  path for Forge to discover endpoints behind a bot wall, then emit fast HTTP tools.
