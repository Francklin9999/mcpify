# 04 — Legal Modes (Cross-Cutting Policy)

This is a **policy doc with concrete enforcement points**, not a philosophy page. Two runtimes enforce
it: the **scraper** (robots.txt/ToS) and the **extension** (session/credentials). Both link here. The
`LegalMode` enum is frozen in `01-contracts.md §6`.

## Key framing (put this in the product copy)

> Position the product as a **user-automation tool, not a scraper.** Generated code runs **locally** on
> the user's machine. We never store scraped content at scale server-side.

## The three modes (user chooses) + the never-do list

| Mode | What it does | Legality | Enforced in |
|------|--------------|----------|-------------|
| **`safe`** (default) | Respects robots.txt. Public pages only. No session. | Clearly legal everywhere. | scraper |
| **`full_scrape`** | Ignores robots.txt. Public pages only. User acknowledges civil ToS risk. | Grey — civil ToS risk; requires explicit user acknowledgement. | scraper |
| **`session`** (extension only) | Acts inside the user's already-logged-in browser, their own account. | Grey but user-automation precedent (Amazon v. Perplexity forming). User's own account only. | extension |
| **NEVER DO** | Store credentials server-side. Scrape behind a login via the web app. Bypass CAPTCHAs on auth walls. | Out of bounds — do not implement. | all |

## Enforcement points (concrete)

### Scraper (`services/scraper.md` links here)
1. **`safe` mode:** before any fetch, fetch & parse `robots.txt`; if the path is disallowed, abort and
   return `CaptureBundle.meta.robotsAllowed = false` with no content. Generator marks server `broken`/refuses.
2. **`full_scrape` mode:** only reachable when the API call carried an explicit user-acknowledgement flag
   (web app gates this behind a confirm dialog). Still **public pages only** — no auth, no session cookies.
3. **Never** accept or forward login credentials. Scraper has no credential inputs by design.

### Extension (`apps/extension.md` links here)
1. **`session` mode** uses the browser's existing cookies implicitly (the user is already logged in).
   The extension **must not** read, export, or transmit cookies/credentials. It only observes
   request/response **schemas** via `chrome.webRequest`.
2. **Credential/secret scrubbing:** before any `CaptureBundle` leaves the client, strip `Authorization`,
   `Cookie`, `Set-Cookie`, `x-api-key`, bearer tokens, and any header on the secret-list below. Only
   **schemas** of bodies are sent, never raw values that could contain secrets/PII.
3. CAPTCHAs on auth walls are never bypassed or automated.

### Server-side storage (`02-data-model.md` links here)
- R2 stores **generated code** and **sanitized capture bundles** only. Never raw scraped content at scale,
  never credentials. `contributions.bundle_ref` is written only when `legalMode` permits storage.

## Secret-list (header/field sanitization — referenced by `NetworkCapture` producers)

Strip before persistence or transmission (case-insensitive): `authorization`, `cookie`, `set-cookie`,
`x-api-key`, `x-auth-token`, `proxy-authorization`, anything matching `*token*`, `*secret*`, `*password*`,
`*session*`. Bodies: send inferred `JsonSchema` only, never raw values.

> Implementer must keep this list in one shared constant (in `packages/types` / mirrored) so scraper and
> extension scrub identically.

## Acceptance criteria
- A `safe`-mode request to a robots-disallowed path produces **zero** stored content.
- No code path persists a value from the secret-list to Postgres, Redis, or R2 (add a test that greps stored payloads).
- **Contract-layer backstop (implemented):** `NetworkCapture` in `packages/types` rejects any secret-list
  header at `parse()` — a producer that forgets to scrub fails closed (throws) rather than leaking.
- `full_scrape` is unreachable without the acknowledgement flag.

## Open questions
- Exact jurisdiction copy for the acknowledgement dialog (legal review, not engineering).
- Retention window for `pending` contributions before auto-purge.
