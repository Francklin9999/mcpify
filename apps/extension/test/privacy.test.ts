import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPagePrivacy, filterSafeSnapshot, privacyReportText, redactSensitiveText } from "../lib/privacy.js";

test("checkout/payment pages are restricted and produce a user-visible report", () => {
  const report = assessPagePrivacy({
    url: "https://shop.example.com/checkout/payment",
    title: "Checkout",
    visibleText: "Enter card number 4111 1111 1111 1111 and CVV",
    forms: [{ purpose: "form", fields: [{ name: "cardNumber", type: "text" }, { name: "cvv", type: "text" }] }],
  });

  assert.equal(report.restricted, true);
  assert.ok(report.items.some((item) => item.kind === "page"));
  assert.ok(report.items.some((item) => item.kind === "form"));
  assert.match(privacyReportText(report), /withheld page context/);
});

test("safe product/listing pages keep useful context", () => {
  const { snapshot, report } = filterSafeSnapshot({
    url: "https://shop.example.com/products/boots",
    title: "Boots",
    outline: ["h1: Boots"],
    actions: ["button: Add to cart", "link: Size guide"],
    actionItems: [{ kind: "button", label: "Add to cart", selector: "button.add" }],
    forms: [{ purpose: "search", fields: [{ name: "q", type: "search" }] }],
    visibleText: "Waterproof boots in stock. Free returns.",
    html: "<html><body><h1>Boots</h1></body></html>",
  });

  assert.equal(report.restricted, false);
  assert.equal(snapshot.visibleText, "Waterproof boots in stock. Free returns.");
  assert.equal(snapshot.actions.length, 2);
  assert.equal(snapshot.actionItems.length, 1);
  assert.equal(snapshot.forms.length, 1);
  assert.equal(snapshot.html.includes("Boots"), true);
});

test("non-restricted snapshots redact sensitive lines and list the redaction", () => {
  const report = { items: [] };
  const text = redactSensitiveText("Public docs\nAPI token: abc123\nNormal content", report);

  assert.equal(text, "Public docs\nNormal content");
  assert.match(report.items[0].detail, /1 line/);
});

test("restricted snapshots drop DOM, forms, actions, app state, and visible text", () => {
  const { snapshot, report } = filterSafeSnapshot({
    url: "https://shop.example.com/account/settings",
    title: "Account settings",
    outline: ["h1: Account"],
    actions: ["button: Save"],
    actionItems: [{ kind: "button", label: "Save card", selector: "button.save" }],
    forms: [{ purpose: "form", fields: [{ name: "email", type: "email" }] }],
    appState: [{ source: "__NEXT_DATA__", keys: ["user"], schema: { type: "object" } }],
    selectorsOfInterest: [{ role: "input", selector: "input[name=email]" }],
    visibleText: "Email jane@example.com",
    html: "<html><body>private</body></html>",
  });

  assert.equal(report.restricted, true);
  assert.equal(snapshot.html, "");
  assert.equal(snapshot.visibleText, "");
  assert.deepEqual(snapshot.forms, []);
  assert.deepEqual(snapshot.actions, []);
  assert.deepEqual(snapshot.appState, []);
  assert.deepEqual(snapshot.selectorsOfInterest, []);
});
