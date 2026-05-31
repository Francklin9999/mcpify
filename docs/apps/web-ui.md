# App — Web UI / Frontend Design Spec

Design direction for `apps/web`, adapted from the Jobright reference the user shared. This doc covers
**layout, component mapping, and the confidence visual system**. It implements the screens in
`apps/web.md` and consumes only the API + shapes in `01-contracts.md`. Logic stays in `web.md`; this is
the visual/IA layer.

> **Why this reference fits:** Jobright's per-card **match-score panel** is structurally identical to our
> per-server **confidence score** (`01 §5`). Their "Ask Orion" assistant is our web-embedded `/api/assist`
> (`01 §7`). The whole layout already expresses "ranked list of scored items + an assistant" — which is
> exactly the library + assist product. We adopt the *structure*, re-skin to our brand and domain.

## Three-column layout (matches reference)

```
┌────────────┬───────────────────────────────────────────┬─────────────────────┐
│  NAV RAIL  │   TOP BAR (tabs · search · filter pills)   │   CONTEXT PANEL     │
│ (persistent)├──────────────────────────────────────────┤  user / plan        │
│            │                                            │  saved filters      │
│  Library   │   SERVER CARD ───────────────┐ ┌────────┐ │  ─────────────────  │
│  Generate  │   favicon · title · tags     │ │ 86%    │ │  ASSISTANT (Orion-  │
│  My Servers│   tool count · last parsed   │ │ STRONG │ │   equivalent)       │
│  Monitor   │   [hide][save][Ask][Install] │ │ MATCH  │ │  welcome + tasks    │
│  Docs      │   ───────────────────────────┘ └────────┘ │  "Ask me anything…" │
│            │   SERVER CARD …                            │  (POST /api/assist) │
│  Refer     │   SERVER CARD …                            │                     │
│  Feedback  │                                            │                     │
│  Settings  │                                            │                     │
└────────────┴───────────────────────────────────────────┴─────────────────────┘
```

## Component mapping (reference → our domain)

| Reference (Jobright) | Our component | Data source |
|----------------------|---------------|-------------|
| Left nav: Jobs/Resume/Agent… | **Library · Generate · My Servers · Monitor · Docs** (+ Refer/Feedback/Settings bottom) | client routes |
| Top tabs: Recommended/Liked/Applied/External | **Curated · Auto-gen · Community · Installed** | `GET /api/registry?tier=` |
| Search "by title or company" | Search by site / tool name | `GET /api/registry?q=` |
| Filter pills (Montreal, Full-time, Onsite…) | **Category · Tier · Confidence ≥ · Status · Last parsed · Tool count** | registry query params |
| Sort "Recommended ▾" | Sort: **Confidence · Install count · Recently parsed** | registry query |
| Job card (logo, title, company, meta) | **Server card** (favicon, site title, URL+category tags, badge) | `RegistryEntry` (`01 §5`) |
| Card meta rows (location, salary, exp) | tool count · last-parsed · install count · execution kind (http/browser) | `RegistryEntry` + `tools` |
| "86% STRONG MATCH" gradient panel | **Confidence band panel** (see below) | `RegistryEntry.confidence` |
| Card actions: hide / ♥ / Ask Orion / Apply with Autofill | **Hide · Save · Ask · Install** (Install = primary) | actions + `/download` |
| Right "Orion" assistant + "Ask me anything" | **Web assistant panel** | `POST /api/assist` (`01 §7`) |
| Right "Your Saved Filters" | Saved registry searches | client/user state |
| Right profile card (Franck, Free Plan) | User + plan card | auth |

## The confidence visual system (the standout reuse)

The reference's match-score block is our biggest win — re-bind it directly to `RegistryEntry.confidence`
(0..1, `01 §5`). It doubles as **functional signal**, not decoration: color = health.

| Confidence | Band label | Tier hint | Color direction |
|-----------|------------|-----------|-----------------|
| ≥ 0.95 | **VERIFIED** | curated (always ≥0.95) | deep green gradient |
| 0.80–0.95 | **STRONG** | healthy auto-gen | green |
| 0.60–0.80 | **FAIR** | usable, watch it | amber |
| < 0.60 | **NEEDS HEALING** | degraded/broken | red |

- Render as the circular-percentage + label block from the reference, on a gradient panel at the card's
  right edge.
- A `status='regenerating'` server shows a pulsing/shimmer state over the panel ("self-healing…").
- Tie the band color to `servers.status` too: `broken` forces the red treatment regardless of last score.

## Screens (implements `apps/web.md` §Screens)

1. **Library** (default, this layout). Tabs = tier. Cards ranked by confidence by default.
2. **Generate.** "Paste a URL" hero with legal-mode selector (`safe` default; `full_scrape` ⇒
   acknowledgement dialog, `04`). Live job status via `GET /api/jobs/:id` rendered as a progress card that
   *becomes* a server card on completion, with download + copy-paste config snippet.
3. **Server detail.** Tools list (name · description · confidence · http/browser), version history,
   confidence-over-time sparkline (from `health_events`, `02`), "report broken" → contribution/heal hint.
4. **Monitor** (My Servers). Health dashboard of the user's servers — status chips, last-parsed, recent
   `health_events`. Read-only view of the flywheel.

## Assistant panel (web mirror of the side panel)

The right-column assistant is the **web embodiment of the extension side panel** — same `POST /api/assist`
transport (`01 §7`), so the Claude key stays server-side and prompts are cached. Content:
- Welcome line + **"Tasks I can assist with":** *Generate a server from a URL · Find servers for a
  workflow · Explain a tool · Diagnose a broken server.* (mirrors the reference's task list)
- "Ask me anything…" streaming chat input.
- "Ask" on any card pre-fills the assistant with that server's context.

## Visual direction & tokens

- **Stack:** Next.js + **shadcn/ui** (per `00`/`web.md`). Build cards, pills, tabs, dialog from shadcn primitives.
- **Tokens:** define in `packages/config` or `web/styles` — a confidence color ramp (green→amber→red),
  neutral card surfaces, one brand accent. Keep the confidence ramp as **named semantic tokens**
  (`--confidence-verified` … `--confidence-low`) so the same ramp is reused in Monitor + detail sparkline.
- **Density:** card list is the primary surface; keep it scannable — generous row height, one primary
  action (Install) emphasized, secondary actions quiet (icon buttons).
- **Responsive:** the right context panel collapses to a drawer below `lg`; nav rail collapses to icons.

## How to test in isolation
- Storybook/component tests with fixture `RegistryEntry[]` covering each confidence band + `regenerating`/
  `broken` states. Mock the API (MSW). No backend needed.
- Snapshot the confidence panel at 0.97 / 0.85 / 0.7 / 0.4 to lock the band thresholds.

## Acceptance criteria
- Confidence band, color, and label derive **solely** from `RegistryEntry.confidence` + `status` (`01 §5`)
  — no hardcoded per-card values.
- Tabs map to `tier`; filter pills map to registry query params; sort changes ordering.
- Assistant panel streams from `POST /api/assist` and "Ask" pre-loads card context.
- Generate flow's progress card transitions into a server card on job completion.

## Open questions (verify before coding)
- **shadcn/ui** current install/component API — verify, don't code from memory.
- Brand identity (logo, accent hue) — the reference uses a green accent; confirm ours.
- Should "Installed" tab require accounts, or use local state for anonymous users? (ties to `web.md` auth open Q).
- Exact confidence-band thresholds (0.95/0.80/0.60) — tune with real generated-server data.
