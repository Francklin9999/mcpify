# MCP Forge - Chrome extension (chat + drive-the-page + MCP generation)

A **static MV3 extension** - no build step. The chat lives in the **side panel** and does two things:

1. **Drive the current page on your behalf** - ask in plain language ("search for X and open the first
   result", "add this to the cart", "go to the next page") and the assistant runs a tool loop against your
   **live tab** (it reads the page, clicks, types, navigates, extracts). It acts as your real, signed-in
   session, so **every page-changing action (click/type/select) and every off-origin navigation asks you to
   confirm first** - Confirm or Skip, inline in the chat.
2. **Turn the page into a runnable MCP server** - the server's response *is* the MCP-protocol server file
   (`server.ts` + `claude_desktop_config.json`), surfaced in the chat to copy/download and run locally.

## Load it in Chrome (dev mode)

1. Make sure the web app is running (default `http://localhost:3001`) - see the repo root `README.md`.
2. Open `chrome://extensions`, toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select **this folder** (`apps/extension`).
4. Pin the extension; click it -> **Open page chat** (or just click the icon to open the side panel).
   If your web app runs elsewhere, set the URL in **Settings** (the extension's options page).

That's it - no `npm install`, no build. Chrome loads the folder directly.

## What's in the folder

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (loadable as-is) |
| `background.js` | Service worker - opens the side panel + net-intercept (records XHR per tab; secrets dropped) |
| `sidepanel.html` / `.js` | **The chat** (the product): drive-the-page agent loop + "Make MCP server for this page" |
| `lib/agent.js` | **Pure** agent loop - when to confirm, how tool results thread back, when to stop. Unit-tested offline |
| `lib/tab-tools.js` | Live-tab tool executors (`chrome.scripting`/`chrome.tabs`): snapshot/click/type/select/navigate/extract |
| `popup.html` / `.js` | Toolbar launcher (open chat / one-click generate) |
| `options.html` / `.js` | Set the web API base URL |
| `ui.css` | Shared styling |
| `lib/api.js` | Web API client (`/api/generate`, `/api/jobs/:id`, `/api/assist`) - talks only to the web app |
| `lib/capture.ts` + `test/` | Contract-proof unit test + the **agent-loop unit test** (`test/agent.test.ts`). Build/test only - Chrome ignores it. |

## How "drive the page" works

The side panel runs an **agent loop** entirely client-side: it asks the model for one step at a time
(`POST /api/assist` with the live-tab `tools`), executes any returned tool call against your current tab via
`chrome.scripting`, and feeds the result (a fresh page snapshot) back for the next step. The model never
touches your tab directly - `lib/tab-tools.js` does, and only after `lib/agent.js` has gated the action:

- **Reads run freely** - `browser_snapshot`, `browser_read_page`, `browser_extract`, and *same-origin*
  navigation.
- **Mutations and off-origin navigations confirm** - `browser_click` / `browser_type` /
  `browser_select_option`, and any `browser_navigate` to a different origin, show an inline **Confirm / Skip**
  card. A bare GET to another origin can be consequential on a logged-in session (`/logout`,
  `/cart/add?id=...`), so it's gated too. Skipping is fed back to the model so it can adapt.
- **Stop** aborts the loop immediately, including while a confirm card is pending.

The snapshot uses the **same `data-__mcp_ref` scheme** as the downloadable headless server, so the in-browser
and downloaded surfaces behave identically.

## How "make an MCP server" works

Chat -> `POST /api/generate { url, legalMode:"safe" }` -> poll `GET /api/jobs/:id` until `done` ->
the job result is the `GeneratedServerArtifact` (the MCP files). The chat shows the tool list, the
`claude_desktop_config.json` snippet to paste into your MCP client, and copy/download of `server.ts`.
Generated servers **run locally on your machine** - credentials never leave the browser.

## Known limitations (honest)

- **The drive-the-page agent is verified by unit test for its CONTROL FLOW only.** `test/agent.test.ts`
  proves the loop's logic (confirm-gating actually blocks a declined action, off-origin navigation confirms,
  multi-step result threading, step cap, abort). The tab-touching executors (`lib/tab-tools.js`) and the live
  `/api/assist` function-calling round-trip are **only exercised in a loaded extension with `OPENAI_API_KEY`
  set on the web app** - they are not covered offline. Load it and try a real task to validate end-to-end.
- **Agent needs a model key.** Without `OPENAI_API_KEY` on the web app, `/api/assist` returns a graceful
  "can't drive the page" step instead of tool calls.
- **Extension capture now feeds generation, but runtime auth replay is still v1-out.** The side panel sends
  a scrubbed `CaptureBundle` from the live tab (`legalMode:"session"`): sanitized DOM, selectors, forms,
  and observed XHR/fetch metadata. This is much stronger than a server-side re-fetch for sites with bot
  walls. Generated tools still execute as public HTTP tools in v1 - cookies/credentials are never exported,
  so account-only actions may still fail or be omitted.
- **Hard sites still need recipes.** The generator has a deterministic site-recipe hook for known domains
  (Amazon starts with `search_products` and `get_product_page`). Add more recipes when a domain has stable,
  useful public actions that capture/model inference misses.
- **CORS - the #1 thing to verify on a real unpacked load.** The side panel `fetch`es
  the local API base from `mcp.config.json` (default `http://localhost:3001`) from a
  `chrome-extension://` origin. MV3 `<all_urls>` host_permissions *should*
  allow this without CORS headers, but if requests fail in a loaded extension, add permissive CORS headers
  for the extension origin on the web API routes (or via `next.config` headers).

## Test the unit suites

```bash
npm run test --workspace=@mcp/extension   # capture bundle contract + agent-loop control flow (15 tests)
```
