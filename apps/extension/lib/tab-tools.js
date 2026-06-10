// lib/tab-tools.js - executes the side-panel agent's browser_* tools against the user's current tab via
// chrome.scripting / chrome.tabs, as the user's signed-in session (why mutating actions are confirmed). The
// in-page functions mirror the headless toolkit in codegen.ts (same data-__mcp_ref tag-then-resolve scheme),
// with refs re-assigned on every snapshot. Needs the extension loaded in Chrome (not unit-tested offline).

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function resolveUrl(target, baseUrl) {
  try {
    return new URL(String(target), baseUrl).toString();
  } catch {
    return String(target || "");
  }
}

function sameUrl(a, b) {
  try {
    const left = new URL(String(a));
    const right = new URL(String(b));
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return String(a || "") === String(b || "");
  }
}

/** Wait until the tab finishes loading (status 'complete'), with a hard timeout so we never hang the loop. */
function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // in case it's already complete (or never fires), poll once and cap with the timeout
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

async function runInPage(tabId, func, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: arg === undefined ? [] : [arg],
    func,
  });
  return res ? res.result : undefined;
}

function interpolate(template, args, encode = false) {
  return String(template == null ? "" : template).replace(/\{\{?(\w+)\}\}?/g, (_m, key) => {
    const value = args && args[key];
    const text = value == null ? "" : String(value);
    return encode ? encodeURIComponent(text) : text;
  });
}

function interpolateUrl(payload) {
  const template = payload && payload.template;
  const args = (payload && payload.args) || {};
  const rawTemplate = String(template == null ? "" : template);
  const direct = rawTemplate.match(/^\s*\{\{?(\w+)\}\}?\s*$/);
  if (direct) {
    const value = args && args[direct[1]];
    return value == null ? "" : String(value);
  }
  const raw = rawTemplate.replace(/\{\{?(\w+)\}\}?/g, (_m, key) => {
    const value = args && args[key];
    return value == null || String(value) === "" ? "" : encodeURIComponent(String(value));
  });
  try {
    const url = new URL(raw, location.href);
    for (const [key, value] of Array.from(url.searchParams.entries())) {
      if (value === "") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw.replace(/([?&])[^=&#]+=(?=(&|#|$))/g, (_m, sep, tail) => (sep === "?" && tail === "&" ? "?" : sep === "?" ? "" : tail === "&" ? "&" : ""));
  }
}

// in-page functions (serialized & injected - must be self-contained, no outer references)

function privacyReportInPage() {
  const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const pathRe =
    /(?:^|\/|\b)(checkout|payment|billing|shipping|order(?:s|[-_]?confirmation)?|cart|account|profile|settings|login|log[-_]?in|signin|sign[-_]?in|signup|sign[-_]?up|register|password|reset|auth|oauth|sso|session|wallet|address|invoice)(?:\/|\b|$)/i;
  const fieldRe =
    /(?:password|passcode|otp|2fa|mfa|token|secret|session|auth|cookie|csrf|card|cc-|credit|cvv|cvc|security[-_ ]?code|expiry|expiration|routing|iban|bank|ssn|sin|tax|address|phone|email)/i;
  const textRe =
    /(?:checkout|payment|billing|shipping address|card number|credit card|debit card|cvv|cvc|security code|expiration date|password|one[-_ ]?time code|verification code|social security|order confirmation|invoice)/i;
  const longDigits = /\b(?:\d[ -]?){12,19}\b/;
  const items = [];
  const add = (kind, label, detail) => {
    const key = kind + ":" + label + ":" + (detail || "");
    if (!items.some((item) => item.key === key)) items.push({ key, kind, label, detail });
  };
  if (pathRe.test(location.href)) add("page", "Sensitive URL", "checkout/account/payment-style path");
  if (textRe.test(document.title)) add("page", "Sensitive title", clean(document.title).slice(0, 80));
  for (const form of Array.from(document.forms || [])) {
    const fields = Array.from(form.elements || []);
    const formText = clean([form.action, form.getAttribute("name"), form.id, form.getAttribute("aria-label")].filter(Boolean).join(" "));
    if (pathRe.test(formText) || fieldRe.test(formText)) add("form", "Sensitive form", form.action || formText.slice(0, 80));
    for (const field of fields) {
      const fieldText = clean([field.getAttribute?.("name"), field.getAttribute?.("type"), field.getAttribute?.("autocomplete"), field.getAttribute?.("placeholder"), field.id].filter(Boolean).join(" "));
      if (fieldRe.test(fieldText)) add("field", "Sensitive field", fieldText.slice(0, 80));
    }
  }
  let bodyText = "";
  try { bodyText = clean(document.body ? document.body.innerText : "").slice(0, 4000); } catch {}
  if (textRe.test(bodyText) || longDigits.test(bodyText)) add("text", "Sensitive page text", "payment/auth/order details detected");
  const publicItems = items.map(({ kind, label, detail }) => ({ kind, label, detail }));
  return { restricted: publicItems.some((item) => ["page", "form", "field", "text"].includes(item.kind)), items: publicItems };
}

function snapshotInPage() {
  const doc = document;
  const privacy = privacyReportInPage();
  if (privacy.restricted) return { privacyBlocked: true, url: location.href, title: doc.title, privacy };
  const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  // Broad enough to catch calendar day cells, dropdown options and other ARIA widgets - not just links/buttons.
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
    "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=option]", "[role=combobox]", "[role=listbox]",
    "[role=gridcell]", "[role=spinbutton]", "[role=slider]", "[role=treeitem]",
    "[aria-haspopup]", "[onclick]", "[contenteditable=true]", "[data-date]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const candidates = [];
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (rect.width === 0 && rect.height === 0) continue;
    try {
      const style = getComputedStyle(el);
      if (style && (style.visibility === "hidden" || style.display === "none")) continue;
    } catch {}
    const inView = rect.bottom > -120 && rect.top < vh + 120 && rect.right > 0 && rect.left < vw;
    candidates.push({ el, inView });
  }
  // In-viewport elements first (what the user/agent is actually looking at), then the rest - capped small.
  candidates.sort((a, b) => (a.inView === b.inView ? 0 : a.inView ? -1 : 1));
  const elements = [];
  for (const c of candidates) {
    if (elements.length >= 50) break;
    const el = c.el;
    const ref = "e" + (elements.length + 1);
    try {
      el.setAttribute("data-__mcp_ref", ref);
    } catch {
      continue;
    }
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = clean(
      el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.textContent || el.getAttribute("title") || el.getAttribute("name"),
    ).slice(0, 60);
    const type = el.getAttribute("type") || "";
    const state = [];
    if (el.getAttribute("aria-selected") === "true") state.push("selected");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) state.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") state.push("disabled");
    if (el.checked) state.push("checked");
    elements.push({ ref, role, name, type, state: state.join(",") });
  }
  // Flag an open overlay/popup so the model knows its days/options are in the list above.
  let overlay = "";
  try {
    const ov = doc.querySelector("[role=dialog],[role=listbox],[role=grid],[role=menu],[aria-modal=true]");
    if (ov && ov.getBoundingClientRect().height > 0) overlay = ov.getAttribute("role") || "dialog";
  } catch {}
  let text = "";
  try {
    text = clean(doc.body ? doc.body.innerText : "").slice(0, 600);
  } catch {}
  return { url: location.href, title: doc.title, elements, text, overlay };
}

function clickInPage(ref) {
  const el = document.querySelector('[data-__mcp_ref="' + String(ref).replace(/[^a-zA-Z0-9_-]/g, "") + '"]');
  if (!el) return { error: "No element for ref " + ref + ". Call browser_snapshot for current refs." };
  try {
    el.scrollIntoView({ block: "center" });
  } catch {}
  // Some widgets (calendars, custom dropdowns) only react to a full mouse sequence, not a bare .click().
  try {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  } catch {}
  try {
    el.click();
  } catch {}
  return { ok: true };
}

function bySelectorInPage(target) {
  const selectors = [target && target.selector, ...((target && target.fallbackSelectors) || [])].filter(Boolean);
  for (const selector of selectors) {
    try {
      const el = document.querySelector(String(selector));
      if (el) return el;
    } catch {}
  }
  return null;
}

function hasSelectorInPage(target) {
  const el = bySelectorInPage(target);
  if (!el) return false;
  try {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
  } catch {
    return true;
  }
}

function clickSelectorInPage(target) {
  const el = bySelectorInPage(target);
  if (!el) return { error: "No element for selector " + (target && target.selector) };
  try {
    el.scrollIntoView({ block: "center" });
  } catch {}
  try {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  } catch {}
  try {
    el.click();
  } catch {}
  return { ok: true };
}

function setNativeValue(el, value) {
  // React/Vue track input value via a property setter; a plain `el.value = x` bypasses it and the framework
  // never sees the change. Call the prototype's native setter so onChange fires.
  try {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
      return;
    }
  } catch {}
  el.value = value;
}

function typeInPage(arg) {
  const el = document.querySelector('[data-__mcp_ref="' + String(arg.ref).replace(/[^a-zA-Z0-9_-]/g, "") + '"]');
  if (!el) return { error: "No element for ref " + arg.ref + ". Call browser_snapshot for current refs." };
  try {
    el.focus();
  } catch {}
  if ("value" in el) {
    setNativeValue(el, arg.text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = arg.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (arg.submit) {
    const form = el.form || (el.closest && el.closest("form"));
    for (const t of ["keydown", "keypress", "keyup"]) {
      try {
        el.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
      } catch {}
    }
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form && typeof form.submit === "function") form.submit();
  }
  return { ok: true };
}

function typeSelectorInPage(arg) {
  const el = bySelectorInPage(arg && arg.target);
  if (!el) return { error: "No element for selector " + (arg && arg.target && arg.target.selector) };
  try {
    el.focus();
  } catch {}
  if ("value" in el) {
    setNativeValue(el, arg.text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = arg.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { ok: true };
}

function focusSelectorInPage(target) {
  const el = bySelectorInPage(target);
  if (!el) return { error: "No element for selector " + (target && target.selector) };
  try {
    el.focus();
  } catch {}
  return { ok: true };
}

function pressKeyInPage(arg) {
  const map = { Esc: "Escape", Space: " ", Spacebar: " " };
  const key = map[arg.key] || String(arg.key || "");
  const target =
    (arg.ref && document.querySelector('[data-__mcp_ref="' + String(arg.ref).replace(/[^a-zA-Z0-9_-]/g, "") + '"]')) ||
    document.activeElement ||
    document.body;
  for (const t of ["keydown", "keypress", "keyup"]) {
    try {
      target.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, cancelable: true }));
    } catch {}
  }
  return { ok: true };
}

function selectInPage(arg) {
  const el = document.querySelector('[data-__mcp_ref="' + String(arg.ref).replace(/[^a-zA-Z0-9_-]/g, "") + '"]');
  if (!el) return { error: "No element for ref " + arg.ref + " - call browser_snapshot for current refs." };
  const value = String(arg.value);
  return selectValueOnElement(el, value);
}

function selectSelectorInPage(arg) {
  const el = bySelectorInPage(arg && arg.target);
  if (!el) return { error: "No element for selector " + (arg && arg.target && arg.target.selector) };
  const value = String(arg.value);
  return selectValueOnElement(el, value);
}

function selectValueOnElement(el, value) {
  let matched = false;
  if (el.options) {
    for (const opt of Array.from(el.options)) {
      if (opt.value === value || (opt.textContent || "").trim() === value) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
  }
  if (!matched && "value" in el) el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

function readInPage() {
  const privacy = privacyReportInPage();
  if (privacy.restricted) return formatPrivacyBlocked({ url: location.href, title: document.title, privacy });
  const clean = (v) => String(v == null ? "" : v).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const body = document.body ? document.body.innerText : "";
  const text = clean(body);
  return text.length > 40000 ? text.slice(0, 40000) + "\n...[truncated]" : text;
}

function extractInPage(mode) {
  const privacy = privacyReportInPage();
  if (privacy.restricted) return { privacyBlocked: true, url: location.href, title: document.title, withheld: privacy.items };
  const doc = document;
  const loc = location;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const textOf = (selectors) => {
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const t = clean(node && node.textContent);
      if (t) return t;
    }
    return "";
  };
  const attrOf = (selectors, attr) => {
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const v = node && node.getAttribute(attr);
      if (v) return v;
    }
    return "";
  };
  const jsonLd = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
    .slice(0, 12)
    .flatMap((node) => {
      try {
        const parsed = JSON.parse(node.textContent || "null");
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });
  const productLd = jsonLd.find((entry) => {
    const type = entry && entry["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
  if (mode === "product") {
    const offer = productLd && (Array.isArray(productLd.offers) ? productLd.offers[0] : productLd.offers);
    return {
      title: (productLd && productLd.name) || textOf(["h1", "#title", "[data-testid='product-title']"]),
      price: (offer && offer.price) || textOf([".a-price .a-offscreen", "[itemprop='price']", "[data-testid='price']", ".price"]),
      currency: (offer && offer.priceCurrency) || attrOf(["[itemprop='priceCurrency']"], "content"),
      availability:
        offer && typeof offer.availability === "string"
          ? clean(offer.availability.split("/").pop())
          : textOf(["#availability", "[data-availability]", ".availability"]),
      rating: String((productLd && productLd.aggregateRating && productLd.aggregateRating.ratingValue) || textOf([".a-icon-alt", "[itemprop='ratingValue']"]) || ""),
      url: loc.href,
    };
  }
  if (mode === "linkedin_jobs") {
    const pickText = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const text = clean(node && node.textContent);
        if (text) return text;
      }
      return "";
    };
    const jobIdFromUrl = (url) => {
      const match = String(url || "").match(/\/jobs\/view\/(\d+)/i) || String(url || "").match(/[?&]currentJobId=(\d+)/i);
      return match ? match[1] : "";
    };
    const selected = {
      title: textOf([".jobs-unified-top-card__job-title", ".job-details-jobs-unified-top-card__job-title", "h1"]),
      company: textOf([".jobs-unified-top-card__company-name", ".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__subtitle-primary-grouping a"]),
      location: textOf([".jobs-unified-top-card__bullet", ".job-details-jobs-unified-top-card__primary-description-container", ".jobs-unified-top-card__primary-description-container"]),
      workplace: textOf([".jobs-unified-top-card__workplace-type", ".job-details-jobs-unified-top-card__job-insight"]),
      url: loc.href,
      jobId: jobIdFromUrl(loc.href),
      description: textOf(["#job-details", ".jobs-description", ".jobs-box__html-content", ".jobs-description-content__text"]).slice(0, 5000),
    };
    const cardSelectors = [
      "li[data-occludable-job-id]",
      ".jobs-search-results__list-item",
      ".job-card-container",
      "[data-job-id]",
      "li.scaffold-layout__list-item",
    ];
    const cards = [];
    for (const selector of cardSelectors) {
      for (const card of Array.from(doc.querySelectorAll(selector))) {
        if (!cards.includes(card)) cards.push(card);
      }
    }
    const seen = new Set();
    const results = cards
      .map((card) => {
        const link = card.querySelector('a[href*="/jobs/view/"]');
        const url = link && link.href ? link.href : "";
        const text = clean(card.textContent);
        const jobId = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id") || jobIdFromUrl(url);
        return {
          jobId,
          title: pickText(card, [".job-card-list__title", ".job-card-container__link", ".job-card-job-posting-card-wrapper__title", 'a[href*="/jobs/view/"]']) || clean(link && link.textContent),
          company: pickText(card, [".job-card-container__primary-description", ".artdeco-entity-lockup__subtitle", "[class*='company']"]),
          location: pickText(card, [".job-card-container__metadata-item", ".artdeco-entity-lockup__caption", "[class*='location']"]),
          url,
          text: text.slice(0, 700),
        };
      })
      .filter((entry) => {
        const key = entry.jobId || entry.url || `${entry.title}|${entry.company}|${entry.location}`;
        if (!entry.title && !entry.text) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 25);
    return {
      url: loc.href,
      query: {
        keywords: new URLSearchParams(loc.search).get("keywords") || "",
        location: new URLSearchParams(loc.search).get("location") || "",
        start: new URLSearchParams(loc.search).get("start") || "0",
      },
      selectedJob: selected.title || selected.company || selected.description ? selected : null,
      results,
    };
  }
  if (mode === "listing") {
    const seen = new Set();
    return Array.from(doc.querySelectorAll("a[href]"))
      .map((node) => ({ text: clean(node.textContent), href: node.href, node }))
      .filter((e) => e.text && /\/(dp|products?|item|items|itm|sku|p)\//i.test(e.href))
      .map((e) => {
        const card = e.node.closest("article,li,div");
        const cardText = clean(card && card.textContent);
        return {
          title: e.text,
          url: e.href,
          price: (cardText.match(/(?:\$|\u00A3|\u20AC|CAD\s?)[\d,.]+/) || [""])[0],
        };
      })
      .filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
      .slice(0, 24);
  }
  return {
    title: doc.title,
    url: loc.href,
    description: attrOf(['meta[name="description"]', 'meta[property="og:description"]'], "content"),
    headings: Array.from(doc.querySelectorAll("h1,h2,h3")).slice(0, 12).map((n) => clean(n.textContent)).filter(Boolean),
    links: Array.from(doc.querySelectorAll("a[href]")).slice(0, 20).map((n) => ({ text: clean(n.textContent), url: n.href })).filter((e) => e.text),
  };
}

function formatSnapshot(data) {
  if (!data) return "Could not read the page (it may be a restricted or non-web page).";
  if (data.privacyBlocked) return formatPrivacyBlocked(data);
  const lines = (data.elements || []).map(
    (e) =>
      "[" + e.ref + "] " + e.role + (e.type ? " type=" + e.type : "") + (e.state ? " (" + e.state + ")" : "") + (e.name ? ' "' + e.name + '"' : ""),
  );
  let head = "PAGE: " + (data.title || "(untitled)") + "\nURL: " + data.url;
  if (data.overlay) head += "\n(An open " + data.overlay + " is on screen; its days/options are in the list below.)";
  return (
    head +
    "\n\nINTERACTIVE ELEMENTS (pass a [ref] to browser_click / browser_type / browser_select_option):\n" +
    (lines.length ? lines.join("\n") : "(none found)") +
    "\n\nVISIBLE TEXT (excerpt):\n" + (data.text || "")
  );
}

function formatPrivacyBlocked(data) {
  const rows = (data?.privacy?.items || data?.withheld || [])
    .slice(0, 8)
    .map((item) => "- " + item.kind + ": " + item.label + (item.detail ? " (" + String(item.detail).slice(0, 90) + ")" : ""));
  return (
    "PRIVACY GUARD: Page content withheld locally before sending it to the agent.\n" +
    "PAGE: " + (data?.title || "(untitled)") + "\nURL: " + (data?.url || "") +
    "\n\nWITHHELD CONTEXT:\n" + (rows.length ? rows.join("\n") : "- page: sensitive flow detected") +
    "\n\nOnly navigation away from this page or user-confirmed actions should continue."
  );
}

/**
 * Build the agent's `execute(call)` effect: runs one browser_* tool against the active tab and returns a
 * string result (mutating/navigation tools return a fresh snapshot so the model sees the new page).
 */
export function makeTabExecutor() {
  return async function execute(call) {
    const tab = await activeTab();
    if (!tab || !tab.id) return "No active tab.";
    if (!isHttpUrl(tab.url) && call.name !== "browser_navigate") {
      return "The current tab isn't a web page (open an http/https page first).";
    }
    const a = call.arguments || {};
    const snapshot = async () => {
      const text = formatSnapshot(await runInPage(tab.id, snapshotInPage));
      // Trace for diagnosis: open the side panel's devtools (right-click the panel -> Inspect) to read what
      // the agent actually saw - invaluable for figuring out why a calendar/widget step failed.
      try {
        console.debug("[MCP snapshot]\n" + text);
      } catch {}
      return text;
    };

    switch (call.name) {
      case "browser_snapshot":
        return snapshot();
      case "browser_press_key": {
        await runInPage(tab.id, pressKeyInPage, { key: String(a.key || ""), ref: a.ref ? String(a.ref) : undefined });
        await waitForLoad(tab.id, 4000);
        return snapshot();
      }
      case "browser_read_page":
        return String((await runInPage(tab.id, readInPage)) ?? "");
      case "browser_extract":
        return JSON.stringify(await runInPage(tab.id, extractInPage, String(a.mode || "metadata")), null, 2);
      case "browser_navigate": {
        const targetUrl = resolveUrl(a.url, tab.url);
        if (!sameUrl(targetUrl, tab.url)) {
          await chrome.tabs.update(tab.id, { url: targetUrl });
          await waitForLoad(tab.id);
        }
        return snapshot();
      }
      case "browser_back": {
        try {
          await chrome.tabs.goBack(tab.id);
        } catch {
          /* nothing to go back to */
        }
        await waitForLoad(tab.id);
        return snapshot();
      }
      case "browser_click": {
        const r = await runInPage(tab.id, clickInPage, String(a.ref));
        if (r && r.error) return r.error;
        await waitForLoad(tab.id, 6000);
        return snapshot();
      }
      case "browser_type": {
        const r = await runInPage(tab.id, typeInPage, { ref: String(a.ref), text: String(a.text ?? ""), submit: a.submit === true });
        if (r && r.error) return r.error;
        if (a.submit === true) await waitForLoad(tab.id, 6000);
        return snapshot();
      }
      case "browser_select_option": {
        const r = await runInPage(tab.id, selectInPage, { ref: String(a.ref), value: String(a.value ?? "") });
        if (r && r.error) return r.error;
        return snapshot();
      }
      default:
        return "Unknown tool: " + call.name;
    }
  };
}

async function waitForSelector(tabId, target, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await runInPage(tabId, hasSelectorInPage, target).catch(() => false);
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

export async function executeBrowserStepsOnActiveTab(steps, args = {}) {
  const tab = await activeTab();
  if (!tab || !tab.id) return "No active tab.";
  if (!isHttpUrl(tab.url) && !steps.some((step) => step && step.action === "navigate")) {
    return "The current tab isn't a web page (open an http/https page first).";
  }

  const snapshot = async () => formatSnapshot(await runInPage(tab.id, snapshotInPage));
  let extracted;

  for (const step of steps || []) {
    if (!step || !step.action) continue;
    switch (step.action) {
      case "navigate": {
        const targetUrl = resolveUrl(await runInPage(tab.id, interpolateUrl, { template: step.value, args }), tab.url || "");
        if (!sameUrl(targetUrl, tab.url)) {
          await chrome.tabs.update(tab.id, { url: targetUrl });
          await waitForLoad(tab.id);
        }
        break;
      }
      case "waitFor": {
        if (step.target && step.target.selector) {
          await waitForSelector(tab.id, step.target, 8000);
        } else {
          const ms = Number(step.value || 300);
          await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 300));
        }
        break;
      }
      case "click": {
        const r = await runInPage(tab.id, clickSelectorInPage, step.target);
        if (r && r.error) return r.error;
        await waitForLoad(tab.id, 6000);
        break;
      }
      case "fill": {
        const r = await runInPage(tab.id, typeSelectorInPage, { target: step.target, text: interpolate(step.value, args) });
        if (r && r.error) return r.error;
        break;
      }
      case "selectOption": {
        const r = await runInPage(tab.id, selectSelectorInPage, {
          target: step.target,
          value: interpolate(step.value, args),
        });
        if (r && r.error) return r.error;
        break;
      }
      case "pressKey": {
        const key = interpolate(step.value, args);
        if (!key) return "browser pressKey step requires a key.";
        if (step.target?.selector) {
          const focused = await runInPage(tab.id, focusSelectorInPage, step.target);
          if (focused && focused.error) return focused.error;
          const r = await runInPage(tab.id, pressKeyInPage, { key });
          if (r && r.error) return r.error;
        } else {
          const r = await runInPage(tab.id, pressKeyInPage, { key });
          if (r && r.error) return r.error;
        }
        await waitForLoad(tab.id, 6000);
        break;
      }
      case "extract": {
        const mode = String(step.value || "");
        if (mode.startsWith("json:")) {
          extracted = JSON.stringify(await runInPage(tab.id, extractInPage, mode.slice("json:".length)), null, 2);
        } else if (mode === "page_text") {
          extracted = String((await runInPage(tab.id, readInPage)) ?? "");
        } else {
          extracted = await snapshot();
        }
        break;
      }
      default:
        break;
    }
  }

  return extracted ?? snapshot();
}
