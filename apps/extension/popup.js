import { generate } from "./lib/api.js";

const status = document.getElementById("status");
const themeBtn = document.getElementById("theme");
const THEME_KEY = "sidePanelTheme";
const ICONS = {
  moon:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>',
  sun:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
};

async function initTheme() {
  const stored = await chrome.storage.sync.get(THEME_KEY).catch(() => ({}));
  const preferred = stored[THEME_KEY] || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(preferred, false);
}

function applyTheme(theme, persist = true) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  themeBtn.innerHTML = next === "dark" ? ICONS.sun : ICONS.moon;
  themeBtn.title = next === "dark" ? "Use light theme" : "Use dark theme";
  themeBtn.setAttribute("aria-label", themeBtn.title);
  if (persist) chrome.storage.sync.set({ [THEME_KEY]: next }).catch(() => {});
}

themeBtn.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

document.getElementById("open").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (chrome.sidePanel?.open && tab) {
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } else {
    status.textContent = "Side panel unavailable in this browser.";
  }
});

document.getElementById("gen").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    status.textContent = "No active tab URL.";
    return;
  }
  status.textContent = "Queuing...";
  try {
    const { jobId } = await generate(tab.url, "safe");
    status.innerHTML = `Queued <code>${jobId.slice(0, 8)}...</code>. Open the chat to watch it.`;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage ? chrome.runtime.openOptionsPage() : window.open("options.html");
});

initTheme();
