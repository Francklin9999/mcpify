// OpenCLI Stealth — runs in the MAIN world at document_start, before any page/anti-bot script.
// Goal: remove the standard *automation* tells that cause FALSE bot flags when opencli drives YOUR own
// Chrome over CDP. This is fingerprint hygiene for a real browser, not a CAPTCHA solver — behavioral
// signals (mouse/timing) and IP reputation still matter, and advanced vendors (PerimeterX) may still
// challenge a cold profile. Every patch is wrapped so a failure never breaks the page.
(() => {
  "use strict";
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true }); } catch { /* ignore */ }
  };

  // 1. navigator.webdriver — the #1 tell. Force it to false (CDP/automation sets it true).
  try {
    if (navigator.webdriver !== false) def(Object.getPrototypeOf(navigator), "webdriver", () => false);
    def(navigator, "webdriver", () => false);
  } catch { /* ignore */ }

  // 2. window.chrome — automated Chrome often lacks the populated chrome runtime object a real browser has.
  try {
    if (!window.chrome || typeof window.chrome !== "object") {
      Object.defineProperty(window, "chrome", { value: {}, configurable: true, writable: true });
    }
    const c = window.chrome;
    if (c && !c.runtime) c.runtime = {};
    if (c && !c.app) c.app = { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } };
  } catch { /* ignore */ }

  // 3. navigator.plugins / mimeTypes — headless/automation reports zero plugins. Present a realistic set.
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const fake = [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      ];
      def(navigator, "plugins", () => {
        const arr = fake.slice();
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
        arr.refresh = () => {};
        return arr;
      });
    }
  } catch { /* ignore */ }

  // 4. navigator.languages — automation sometimes leaves this empty.
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      def(navigator, "languages", () => ["en-US", "en"]);
    }
  } catch { /* ignore */ }

  // 5. WebGL vendor/renderer — a headless GPU reports SwiftShader/empty; spoof a common real GPU string
  //    (UNMASKED_VENDOR_WEBGL=37445, UNMASKED_RENDERER_WEBGL=37446).
  try {
    const patchGL = (proto) => {
      if (!proto || proto.__stealth_gl) return;
      const orig = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445) return "Intel Inc.";
        if (param === 37446) return "Intel Iris OpenGL Engine";
        return orig.apply(this, arguments);
      };
      try { Object.defineProperty(proto, "__stealth_gl", { value: true }); } catch { /* ignore */ }
    };
    if (typeof WebGLRenderingContext !== "undefined") patchGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") patchGL(WebGL2RenderingContext.prototype);
  } catch { /* ignore */ }

  // 6. permissions.query for "notifications" — a classic headless inconsistency (returns "denied" while
  //    Notification.permission is "default"). Make them agree.
  try {
    const perms = navigator.permissions;
    if (perms && perms.query) {
      const origQuery = perms.query.bind(perms);
      perms.query = (params) => {
        if (params && params.name === "notifications") {
          return Promise.resolve({ state: Notification.permission === "denied" ? "denied" : "prompt", onchange: null });
        }
        return origQuery(params);
      };
    }
  } catch { /* ignore */ }
})();
