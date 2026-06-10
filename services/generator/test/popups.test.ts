import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDismissScript, CONSENT_ACCEPT_SELECTORS, CONSENT_ACCEPT_TEXT, emitPopupRuntime } from "../src/popups.js";
import { generateServerSource } from "../src/codegen.js";

test("buildDismissScript is a self-contained IIFE that returns a JSON summary", () => {
  const s = buildDismissScript();
  assert.match(s, /^\(function\(\)\{/);
  assert.match(s, /dismissed/);
  assert.ok(s.includes("#onetrust-accept-btn-handler"), "OneTrust selector present");
  assert.ok(s.includes("#CybotCookiebotDialogBodyButtonAccept"), "Cookiebot selector present");
  assert.ok(s.includes("cookie"), "container scope present");
});

// The script is pure DOM logic; exercise it in a minimal DOM stub to prove it clicks ONLY consent controls.
type Btn = { id?: string; cls?: string; text?: string; container?: boolean };
function domStub(buttons: Btn[]) {
  const clicked: string[] = [];
  const mk = (b: Btn) => ({
    id: b.id || "", className: b.cls || "", textContent: b.text || "",
    offsetWidth: 10, offsetHeight: 10, getClientRects: () => [{}],
    click() { clicked.push(b.id || b.cls || ("text:" + (b.text || "").toLowerCase())); },
    querySelectorAll: () => [] as unknown[],
  });
  const nodes = buttons.map((b) => ({ ...mk(b), _b: b }));
  const matchSel = (n: { id: string; className: string }, sel: string) => {
    if (sel.startsWith("#")) return !!n.id && sel === "#" + n.id;
    if (sel.startsWith(".")) return !!n.className && ("." + n.className.split(" ").join(".")).includes(sel);
    return false;
  };
  const doc = {
    querySelector: (sel: string) => nodes.find((n) => matchSel(n, sel)) || null,
    querySelectorAll: (sel: string) => {
      if (/cookie|consent|gdpr/.test(sel)) {
        const conts = nodes.filter((n) => n._b.container);
        return [{ querySelectorAll: () => conts }];
      }
      return [] as unknown[];
    },
  };
  return { doc, clicked };
}

test("dismiss script clicks a curated OneTrust button and nothing else", () => {
  const { doc, clicked } = domStub([
    { id: "onetrust-accept-btn-handler", text: "Accept All" },
    { id: "subscribe-btn", text: "Subscribe" },
  ]);
  const fn = new Function("document", "return " + buildDismissScript());
  const res = JSON.parse(fn(doc));
  assert.deepEqual(res.dismissed, ["#onetrust-accept-btn-handler"]);
  assert.ok(!clicked.includes("subscribe-btn"), "non-consent button must not be clicked");
});

test("dismiss script falls back to consent-scoped accept text, never page-wide", () => {
  const { doc } = domStub([
    { cls: "cookie-banner-btn", text: "Accept", container: true },
  ]);
  const fn = new Function("document", "return " + buildDismissScript());
  const res = JSON.parse(fn(doc));
  assert.equal(res.dismissed.length, 1);
  assert.match(res.dismissed[0], /^text:accept$/);
});

test("CONSENT tables are non-trivial and lowercased text", () => {
  assert.ok(CONSENT_ACCEPT_SELECTORS.length >= 10);
  for (const t of CONSENT_ACCEPT_TEXT) assert.equal(t, t.toLowerCase());
});

test("emitPopupRuntime emits the DISMISS_SCRIPT constant", () => {
  assert.match(emitPopupRuntime(), /const DISMISS_SCRIPT = /);
});

test("generated server wires browser_dismiss + DISMISS_SCRIPT into both backends", () => {
  const src = generateServerSource({
    serverId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    version: 1, url: "https://example.com/", title: "Example", tools: [], browsing: true,
  });
  assert.match(src, /const DISMISS_SCRIPT = /);
  assert.match(src, /"browser_dismiss"/);
  assert.match(src, /async dismiss\(\)/);
  assert.match(src, /"eval", DISMISS_SCRIPT/);
});
