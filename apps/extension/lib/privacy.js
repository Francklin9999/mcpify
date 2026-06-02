const SENSITIVE_PATH_RE =
  /(?:^|\/|\b)(checkout|payment|billing|shipping|order(?:s|[-_]?confirmation)?|cart|account|profile|settings|login|log[-_]?in|signin|sign[-_]?in|signup|sign[-_]?up|register|password|reset|auth|oauth|sso|session|wallet|address|invoice)(?:\/|\b|$)/i;

const SENSITIVE_FIELD_RE =
  /(?:password|passcode|otp|2fa|mfa|token|secret|session|auth|cookie|csrf|card|cc-|credit|cvv|cvc|security[-_ ]?code|expiry|expiration|routing|iban|bank|ssn|sin|tax|address|phone|email)/i;

const SENSITIVE_TEXT_RE =
  /(?:checkout|payment|billing|shipping address|card number|credit card|debit card|cvv|cvc|security code|expiration date|password|one[-_ ]?time code|verification code|social security|order confirmation|invoice)/i;

const LONG_DIGIT_RE = /\b(?:\d[ -]?){12,19}\b/;

function addReason(report, kind, label, detail) {
  const key = `${kind}:${label}:${detail || ""}`;
  if (report._seen.has(key)) return;
  report._seen.add(key);
  report.items.push({ kind, label, detail });
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_FIELD_RE.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function fieldLooksSensitive(field) {
  const joined = [field?.name, field?.type, field?.label, field?.placeholder, field?.selector].filter(Boolean).join(" ");
  return SENSITIVE_FIELD_RE.test(joined);
}

function formLooksSensitive(form) {
  const joined = [form?.purpose, form?.action, form?.submitLabel, form?.selector].filter(Boolean).join(" ");
  return SENSITIVE_PATH_RE.test(joined) || SENSITIVE_FIELD_RE.test(joined) || (form?.fields || []).some(fieldLooksSensitive);
}

function actionLooksSensitive(action) {
  const label = String(action?.label || "");
  const target = [action?.href, action?.selector, action?.kind].filter(Boolean).join(" ");
  return SENSITIVE_PATH_RE.test(target) || SENSITIVE_FIELD_RE.test(`${label} ${target}`) || SENSITIVE_TEXT_RE.test(label);
}

export function assessPagePrivacy(input = {}) {
  const report = { restricted: false, items: [], _seen: new Set() };
  const url = safeUrl(input.url || "");
  const title = String(input.title || "");
  const text = String(input.visibleText || input.text || "");

  if (SENSITIVE_PATH_RE.test(url)) addReason(report, "page", "Sensitive URL", "checkout/account/payment-style path");
  if (SENSITIVE_TEXT_RE.test(title)) addReason(report, "page", "Sensitive title", title.slice(0, 80));

  for (const form of input.forms || []) {
    if (formLooksSensitive(form)) addReason(report, "form", form.purpose || "Sensitive form", form.action || form.submitLabel || form.selector);
  }
  for (const action of input.actions || input.actionItems || []) {
    if (actionLooksSensitive(action)) addReason(report, "action", action.label || action.kind || "Sensitive action", action.href || action.selector);
  }

  if (SENSITIVE_TEXT_RE.test(text) || LONG_DIGIT_RE.test(text)) {
    addReason(report, "text", "Sensitive page text", "payment/auth/order details detected");
  }

  report.restricted = report.items.some((item) => item.kind === "page" || item.kind === "form" || item.kind === "text");
  delete report._seen;
  return report;
}

export function redactSensitiveText(text, report = { items: [] }) {
  const kept = [];
  let removed = 0;
  for (const line of String(text || "").split(/\n+/)) {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) continue;
    if (SENSITIVE_TEXT_RE.test(compact) || SENSITIVE_FIELD_RE.test(compact) || LONG_DIGIT_RE.test(compact)) {
      removed++;
      continue;
    }
    kept.push(compact);
  }
  if (removed) report.items.push({ kind: "text", label: "Sensitive text lines", detail: `${removed} line${removed === 1 ? "" : "s"} withheld` });
  return kept.join("\n").slice(0, 8000);
}

export function filterSafeSnapshot(snapshot, tabUrl = "") {
  if (!snapshot) return { snapshot: null, report: { restricted: false, items: [] } };
  const report = assessPagePrivacy({ ...snapshot, url: tabUrl || snapshot.url });
  const url = safeUrl(tabUrl || snapshot.url || "");

  if (report.restricted) {
    return {
      report,
      snapshot: {
        title: snapshot.title,
        url,
        outline: [],
        actions: [],
        actionItems: [],
        forms: [],
        appState: [],
        selectorsOfInterest: [],
        visibleText: "",
        html: "",
      },
    };
  }

  const textReport = { items: [] };
  const visibleText = redactSensitiveText(snapshot.visibleText || "", textReport);
  const safeActions = (snapshot.actions || []).filter((line) => !SENSITIVE_TEXT_RE.test(line) && !SENSITIVE_FIELD_RE.test(line));
  const safeActionItems = (snapshot.actionItems || []).filter((action) => !actionLooksSensitive(action));
  const safeForms = (snapshot.forms || []).filter((form) => !formLooksSensitive(form));
  const safeSelectors = (snapshot.selectorsOfInterest || []).filter((item) => !SENSITIVE_FIELD_RE.test([item.role, item.selector].filter(Boolean).join(" ")));
  return {
    report: { restricted: false, items: [...report.items, ...textReport.items] },
    snapshot: {
      ...snapshot,
      url,
      actions: safeActions,
      actionItems: safeActionItems,
      forms: safeForms,
      selectorsOfInterest: safeSelectors,
      visibleText,
    },
  };
}

export function privacyReportText(report) {
  if (!report?.items?.length) return "";
  const rows = report.items.slice(0, 8).map((item) => {
    const detail = item.detail ? ` (${String(item.detail).slice(0, 90)})` : "";
    return `- ${item.kind}: ${item.label}${detail}`;
  });
  return `Privacy guard withheld page context before sending anything to the agent:\n${rows.join("\n")}`;
}
