# MCP Forge — Agent Smithy · Hackathon Pitch

> **One-liner:** Paste any URL → get a runnable MCP server in under a minute. We're the supply side of the agent economy.

Target run time: **~3 minutes** + demo. Beats marked `[SAY]` (spoken) and `[DEMO]` (do on screen).
Replace every `‹…›` with your real measured number before you present.

---

## 0. COLD OPEN — the hook (15s)

`[SAY]`
> "Every AI agent today is blind to 99% of the web — because 99% of the web has no API. There are over **10,000 MCP servers** and **97 million downloads a month**, and *every single one was built by hand by a developer.* We just paste a URL and generate one in under a minute. No API. No docs. No developer."

---

## 1. THE PROBLEM (20s)

`[SAY]`
> "MCP is how agents get tools. But someone has to *build* every server, reading docs that for most of the web don't exist. The market is doubling every year — from ~5,800 servers last April to ~9,400 today — and supply is the bottleneck. Models aren't the limit anymore. **What agents are allowed to touch is the limit.**"

---

## 2. THE SOLUTION (20s)

`[SAY]`
> "MCP Forge fixes the supply side. Paste a URL → a 3-tier scraper captures the page's *real network traffic* → Gemini infers action-capable tools → we emit a **runnable MCP server you drop into Claude in one command.** And it's not one-shot — every server ships a live browsing toolkit so an agent can drive the real page: paginate, fill forms, multi-step flows."

---

## 3. DEMO 1 — Amazon (the "whoa") (45s)

`[DEMO]`
1. Paste `amazon.ca` → generation runs live.
2. Point at the result: **"7 tools, generated from a site with no public API — search, product detail, add-to-cart."**
3. Download → register into Claude Desktop with one command.
4. Ask Claude to search a product and paginate → it drives the *real* Amazon page.

`[SAY] while it runs:`
> "Amazon actively fights scrapers. Our scraper detected the bot wall and escalated to a stealth tier automatically. Seven tools, zero docs, zero developer."

---

## 4. DEMO 2 — LinkedIn, head-to-head vs. Claude's extension (45s) ⭐ THE KILLER

`[SAY]`
> "I wanted to test it against the real alternative, so I tried building this with **Claude's own extension approach** on LinkedIn first."

`[DEMO / SAY]`
> "Claude's extensions make *installing* a server one click — but you still have to *build* it. Building one for LinkedIn by hand was slow and painful: inspect traffic, wire the MCP protocol boilerplate, implement and test each tool. It took me **‹your time — e.g. ~45 minutes / never got it working cleanly›**."
>
> "MCP Forge did it in **‹measured seconds›** — paste the URL, done. **That's the whole pitch in one screen: what took me the better part of an hour, the Forge does in under a minute, and I'm not even a developer in that loop.**"

`[Punch line]`
> "Anthropic made *installing* tools trivial. **We make *creating* them trivial.** That's the hard part, and it's the part nobody else automates."

---

## 5. WHY IT'S HARD — depth (30s)

`[SAY]`
> "Three things make this real engineering, not a scraper:
> 1. We capture **real network traffic**, not HTML — three escalating tiers that detect bot walls and climb to stealth fetchers.
> 2. It **self-heals** — a Go monitor health-checks every server, detects when a site changes, and auto-regenerates. The registry stays alive without us.
> 3. It's a **distributed system** — web API, a queue-decoupled generator worker, a Python scraper, and the Go monitor, each scaling independently."

---

## 6. THE ON-CHAIN MOMENT — Solana (20s)

`[DEMO]` Open Solana Explorer (devnet) on a live record.

`[SAY]`
> "When an agent auto-installs a generated server, how does it trust it? Every server we generate is **registered on-chain** with a tool signature and confidence score — a public, tamper-proof, ownerless registry. **53 servers are live on Solana devnet right now**, verifiable on Explorer. We chose Solana because we write on *every* generation — only a sub-cent, sub-second chain makes that economical."

---

## 7. THE STACK — sponsor sweep (20s)

`[SAY]`
> "And it's built to ship:
> - **Vultr** — deployed as a decoupled microservice stack: web, generator worker, Chromium scraper, Go monitor behind a load balancer, queue-decoupled and independently scalable.
> - **Gemini** — the inference brain that turns raw traffic into structured tools, and the in-browser agent.
> - **Solana** — the on-chain trust registry.
> - **MongoDB Atlas** — the searchable catalog of every server we've forged."

---

## 8. CLOSE (15s)

`[SAY]`
> "Everyone is building agents. Nobody is building the tools fast enough. **MCP Forge turns the entire web into agent-usable tools — generated on demand, kept alive automatically, and registered on-chain so anyone can find and trust them.** It's the missing supply side of the agent economy. We call it **Agent Smithy** — the forge where the web gets hammered into agent tools. Thank you."

---

## 📊 NUMBERS CHEAT-SHEET (memorize these)

| Claim | Number | Status |
|---|---|---|
| Active public MCP servers | **10,000+** (Anthropic, Dec 2025) | ✅ cite |
| Official registry records | **9,652** (May 2026) | ✅ cite |
| Monthly SDK downloads | **97 million** (Mar 2026) | ✅ cite |
| Ecosystem growth | **~5,800 → ~9,400 servers in a year** | ✅ cite |
| Servers we put on-chain | **53 on Solana devnet** | ✅ we did it live |
| Hand-build time (real multi-tool server) | **hours → a day** | ✅ defensible |
| MCP Forge generation | **‹measure it — under a minute›** | ⚠️ MEASURE before pitch |
| Speed advantage | **"hours → under a minute"** | ✅ safe framing |
| "~10–100× faster" | — | ⚠️ say "estimated" if pressed |

**Rule:** never quote a generation-time number you haven't measured. Time Amazon + LinkedIn + Wikipedia and use those exact seconds.

---

## 🛡️ Q&A REBUTTALS (the questions judges will fire)

**"Isn't this just a scraper?"**
> "A scraper gives you HTML. We capture the *network layer*, infer *action-capable tools* with arguments, emit a *runnable MCP server* with a persistent browsing session, and self-heal it when the site changes. Scraping is step one of five."

**"Why does a tool registry need a blockchain?"**
> "Trust and neutrality. An agent auto-installing a server needs to verify it wasn't tampered with — that's the on-chain tool signature. And a registry of what agents can touch shouldn't be owned by one company. On-chain = ownerless, permissionless, verifiable. Solana specifically because we write on every generation and need sub-cent fees."

**"Why not just centralize the registry?"**
> "Then one company gatekeeps what every agent is allowed to use. The whole point is a neutral public good — plus on-chain identity is the foundation for reputation and paying server creators later."

**"What about sites that need login / break / change?"**
> "Login: the persistent browsing session handles authenticated flows turn-by-turn. Breakage: the Go monitor detects drift and auto-regenerates. That's the self-heal loop."

**"How is this different from Claude's Desktop Extensions?"**
> "Those make *installing* a server one click — but you still build it by hand. We automate the build. Installing was never the hard part; creating is."

**"How do you make money?"** → see the Monetization section below; the 10-second version:
> "Generation is the free hook. We charge to keep servers *alive* — hosting + self-heal is a per-server subscription. Enterprises pay to forge servers for their internal tools. And the on-chain registry becomes a marketplace where we take a cut of premium servers."

---

## 💰 MONETIZATION — land, expand, platform

A layered model — free hook → recurring SaaS → platform take-rate. The on-chain registry isn't a gimmick; it's the revenue engine at the top of the funnel.

**1. Free tier — the hook (acquisition)**
A few generations a month, public servers. This is the "paste a URL, holy-shit" moment that gets everyone in the door. Costs us little; drives top-of-funnel.

**2. Pro / Team — the recurring core (MRR)**
> *Generation is the demo. Keeping servers alive is the business.*
Sites change and break; hand-built servers rot. We **host your generated servers and self-heal them** (the Go monitor) — a **per-server / per-seat subscription**. Also unlocks private servers, authenticated flows, more generations, priority + stealth tiers. This is the predictable recurring revenue.

**3. Enterprise — the high-ACV play (B2B)**
Every company has **internal tools and dashboards with no public API** — exactly what agents can't touch. We generate MCP servers for those, deployed **private / in-VPC / on-prem**, with SSO, a private registry, SLA on self-heal, and support. Highest contract value, stickiest.

**4. Marketplace — the platform flywheel (take-rate)** ← *ties Solana to revenue*
The on-chain registry turns into a **tool marketplace**: creators publish premium/curated servers, consumers install them, and we take a **cut of paid installs**. On-chain identity → reputation → creator payouts → network effects. This is why the blockchain is in the architecture: it's the rails for an ownerless marketplace we monetize via transaction fees.

**The one-line story for judges:**
> "We land with free generation, expand into a per-server hosting-and-self-heal subscription, sell private generation to enterprises, and take a cut of an on-chain tool marketplace. The wow-factor demo is also the top of a real revenue funnel."

**Who pays & why now:** agent builders (need tools, fast), enterprises (internal tools, no API), and tool creators (a place to publish and get paid) — all riding a market doubling every year.

---

## SOURCES (for slide footnotes)
- MCP adoption stats 2026 — digitalapplied.com
- MCP 97M downloads — digitalapplied.com
- One Year of MCP (anniversary) — blog.modelcontextprotocol.io
- Composio: building an MCP server from scratch — composio.dev
