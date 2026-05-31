import { generate } from "./lib/api.js";

const status = document.getElementById("status");

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
  status.textContent = "Queuing…";
  try {
    const { jobId } = await generate(tab.url, "safe");
    status.innerHTML = `Queued <code>${jobId.slice(0, 8)}…</code>. Open the chat to watch it.`;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage ? chrome.runtime.openOptionsPage() : window.open("options.html");
});
