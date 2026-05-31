import { generate, waitForArtifact, assistAgentStep, findServerForUrl, discoverTools, apiBase } from "./lib/api.js";
import { buildCaptureBundle } from "./lib/capture.js";
import { ELEVENLABS_STORAGE_KEYS, getElevenLabsSettings, synthesizeWithElevenLabs, transcribeWithElevenLabs } from "./lib/elevenlabs.js";
import { renderMarkdown } from "./lib/markdown.js";
import { zipBlob } from "./lib/zip.js";
import {
  runAgent,
  parseStepResponse,
  needsConfirm,
  BROWSER_TOOL_SPECS,
  discoveredToolSpecs,
  needsConfirmDiscoveredTool,
  httpRequestFromTool,
} from "./lib/agent.js";
import { makeTabExecutor, executeBrowserStepsOnActiveTab } from "./lib/tab-tools.js";
import { ATLAS_STORAGE_KEYS, getAtlasSettings, fetchToolsFromAtlas, saveToolsToAtlas } from "./lib/atlas.js";

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const pageEl = document.getElementById("page");
const welcome = document.getElementById("welcome");
const sendBtn = document.getElementById("send");
const voiceInputBtn = document.getElementById("voiceinput");
const composerHint = document.getElementById("composerhint");
const themeBtn = document.getElementById("theme");
const historyToggleBtn = document.getElementById("historytoggle");
const historyPanel = document.getElementById("historypanel");
const historyList = document.getElementById("historylist");
const autoApproveBtn = document.getElementById("autoapprove");
const speakReplyBtn = document.getElementById("speakreply");
const newChatBtn = document.getElementById("newchat");
const genBtn = document.getElementById("gen");

const history = [];
let activeAbort = null;
let autoApprove = false;
let chatSessions = [];
let activeChatId = null;
let elevenLabsSettings = null;
let atlasSettings = null;
let recordingState = null;
let playingAudio = null;
let speakingBusy = false;

const CHAT_STORAGE_KEY = "sidePanelChatsV1";
const CHAT_ACTIVE_KEY = "sidePanelActiveChatIdV1";
const AUTO_APPROVE_KEY = "sidePanelAutoApproveV1";
const MAX_STORED_CHATS = 20;

const ICONS = {
  moon:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>',
  sun:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  send:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  stop:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  mic:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/><path d="M8 22h8"/></svg>',
  speaker:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
};

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 14)}\n...[truncated]` : text;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function hideWelcome() {
  if (welcome) welcome.hidden = true;
}

function message(role, html) {
  hideWelcome();
  const wrapper = el("div", `msg ${role}`);
  const avatar = el("div", "avatar", role === "user" ? "You" : "◆");
  const body = el("div", "body", html);
  wrapper.append(avatar, body);
  log.appendChild(wrapper);
  scrollToBottom();
  return { wrapper, body };
}

function typingHtml(label = "Thinking") {
  return `<div class="typing" aria-label="${escapeHtml(label)}"><span></span><span></span><span></span></div>`;
}

function setBusy(isBusy) {
  activeAbort = isBusy ? activeAbort : null;
  form.classList.toggle("busy", isBusy);
  sendBtn.innerHTML = isBusy ? ICONS.stop : ICONS.send;
  sendBtn.title = isBusy ? "Stop response" : "Send";
  sendBtn.setAttribute("aria-label", isBusy ? "Stop response" : "Send");
}

function autoGrowInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

async function initPageTitle() {
  const tab = await activeTab().catch(() => null);
  if (!tab?.title) return;
  pageEl.textContent = tab.title.length > 42 ? `${tab.title.slice(0, 42)}...` : tab.title;
  pageEl.title = tab.url || "";
}

async function initTheme() {
  const stored = await chrome.storage.sync.get("sidePanelTheme").catch(() => ({}));
  const preferred = stored.sidePanelTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(preferred, false);
}

/**
 * Pull ElevenLabs + Atlas config from the web app's env and write it into
 * chrome.storage.local as defaults. Any key already set in storage (via the
 * options page) is left untouched — env values never override manual entries.
 */
async function syncConfigFromServer() {
  try {
    const base = await apiBase();
    const res = await fetch(`${base}/api/extension-config`);
    if (!res.ok) return;
    const config = await res.json();

    const allKeys = [...Object.values(ELEVENLABS_STORAGE_KEYS), ...Object.values(ATLAS_STORAGE_KEYS)];
    const stored = await chrome.storage.local.get(allKeys).catch(() => ({}));
    const updates = {};

    if (config.elevenLabs) {
      const el = config.elevenLabs;
      if (el.apiKey   && !stored[ELEVENLABS_STORAGE_KEYS.apiKey])   updates[ELEVENLABS_STORAGE_KEYS.apiKey]   = el.apiKey;
      if (el.voiceId  && !stored[ELEVENLABS_STORAGE_KEYS.voiceId])  updates[ELEVENLABS_STORAGE_KEYS.voiceId]  = el.voiceId;
      if (el.ttsModel && !stored[ELEVENLABS_STORAGE_KEYS.ttsModel]) updates[ELEVENLABS_STORAGE_KEYS.ttsModel] = el.ttsModel;
      if (el.sttModel && !stored[ELEVENLABS_STORAGE_KEYS.sttModel]) updates[ELEVENLABS_STORAGE_KEYS.sttModel] = el.sttModel;
    }
    if (config.atlas) {
      const at = config.atlas;
      if (at.endpoint   && !stored[ATLAS_STORAGE_KEYS.endpoint])   updates[ATLAS_STORAGE_KEYS.endpoint]   = at.endpoint;
      if (at.apiKey     && !stored[ATLAS_STORAGE_KEYS.apiKey])     updates[ATLAS_STORAGE_KEYS.apiKey]     = at.apiKey;
      if (at.dataSource && !stored[ATLAS_STORAGE_KEYS.dataSource]) updates[ATLAS_STORAGE_KEYS.dataSource] = at.dataSource;
      if (at.database   && !stored[ATLAS_STORAGE_KEYS.database])   updates[ATLAS_STORAGE_KEYS.database]   = at.database;
      if (at.collection && !stored[ATLAS_STORAGE_KEYS.collection]) updates[ATLAS_STORAGE_KEYS.collection] = at.collection;
    }

    if (Object.keys(updates).length) {
      await chrome.storage.local.set(updates);
      await Promise.all([loadElevenLabsSettings(), loadAtlasSettings()]);
    }
  } catch {
    // Web app not running or endpoint unavailable — silently skip.
  }
}

async function loadElevenLabsSettings() {
  elevenLabsSettings = await getElevenLabsSettings().catch(() => null);
  updateVoiceUi();
}

async function loadAtlasSettings() {
  atlasSettings = await getAtlasSettings().catch(() => null);
}

function applyTheme(theme, persist = true) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  themeBtn.innerHTML = next === "dark" ? ICONS.sun : ICONS.moon;
  themeBtn.title = next === "dark" ? "Use light theme" : "Use dark theme";
  if (persist) chrome.storage.sync.set({ sidePanelTheme: next }).catch(() => {});
}

function updateVoiceUi() {
  if (voiceInputBtn) {
    const recording = Boolean(recordingState);
    voiceInputBtn.classList.toggle("active", recording);
    voiceInputBtn.innerHTML = recording ? ICONS.stop : ICONS.mic;
    voiceInputBtn.title = recording ? "Stop recording" : "Record voice prompt";
    voiceInputBtn.setAttribute("aria-label", recording ? "Stop recording" : "Record voice prompt");
  }
  if (speakReplyBtn) {
    const active = speakingBusy || Boolean(playingAudio);
    speakReplyBtn.classList.toggle("active", active);
    speakReplyBtn.innerHTML = active ? ICONS.stop : ICONS.speaker;
    speakReplyBtn.title = active ? "Stop playback" : "Play last answer";
    speakReplyBtn.setAttribute("aria-label", active ? "Stop playback" : "Play last answer");
  }
}

function clearChatView() {
  if (activeAbort) activeAbort.abort();
  cancelRecording();
  stopPlayback();
  log.querySelectorAll(".msg").forEach((node) => node.remove());
  if (welcome) welcome.hidden = false;
  input.value = "";
  autoGrowInput();
  setBusy(false);
}

function newChatId() {
  return globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chatTitle(messages) {
  const firstUser = (messages || []).find((entry) => entry && entry.role === "user" && entry.content);
  const base = cleanText(firstUser?.content || "");
  if (!base) return "New chat";
  return base.length > 52 ? `${base.slice(0, 52)}...` : base;
}

function chatPreview(messages) {
  const last = [...(messages || [])].reverse().find((entry) => entry && entry.content);
  const base = cleanText(last?.content || "");
  if (!base) return "Empty";
  return base.length > 44 ? `${base.slice(0, 44)}...` : base;
}

function relativeTime(iso) {
  const stamp = Date.parse(iso || "");
  if (!Number.isFinite(stamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function currentSessionIndex() {
  return chatSessions.findIndex((session) => session.id === activeChatId);
}

function lastAssistantText() {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.role === "assistant" && cleanText(entry.content)) return entry.content;
  }
  return "";
}

function stopPlayback() {
  if (playingAudio) {
    try {
      playingAudio.pause();
      playingAudio.src = "";
    } catch {}
    playingAudio = null;
  }
  speakingBusy = false;
  updateVoiceUi();
}

async function playAssistantReply(text = lastAssistantText()) {
  if (!elevenLabsSettings) await loadElevenLabsSettings();
  const speakText = cleanText(text);
  if (!speakText) {
    message("bot", '<p class="sub">There is no assistant reply to read yet.</p>');
    return;
  }
  if (!elevenLabsSettings?.apiKey) {
    message("bot", '<p class="err">Set your ElevenLabs API key in Settings before using voice playback.</p>');
    return;
  }
  if (speakingBusy || playingAudio) {
    stopPlayback();
    return;
  }
  speakingBusy = true;
  updateVoiceUi();
  try {
    const blob = await synthesizeWithElevenLabs(speakText, elevenLabsSettings);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    playingAudio = audio;
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      stopPlayback();
    }, { once: true });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      stopPlayback();
    }, { once: true });
    speakingBusy = false;
    updateVoiceUi();
    await audio.play();
  } catch (err) {
    stopPlayback();
    message("bot", `<p class="err">Voice playback failed: ${escapeHtml(err?.message || err)}</p>`);
  }
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  const messages = Array.isArray(session.messages)
    ? session.messages
        .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
        .map((entry) => ({ role: entry.role, content: entry.content }))
    : [];
  const updatedAt = typeof session.updatedAt === "string" ? session.updatedAt : new Date().toISOString();
  return {
    id: typeof session.id === "string" ? session.id : newChatId(),
    createdAt: typeof session.createdAt === "string" ? session.createdAt : updatedAt,
    updatedAt,
    messages,
  };
}

function renderSavedMessage(entry) {
  if (!entry) return;
  if (entry.role === "user") {
    message("user", `<p>${escapeHtml(entry.content)}</p>`);
    return;
  }
  message("bot", renderMarkdown(entry.content));
}

function renderHistoryList() {
  if (!historyList) return;
  historyList.innerHTML = "";
  if (!chatSessions.length) {
    historyList.innerHTML = '<p class="history-empty">No saved chats yet.</p>';
    return;
  }
  for (const session of chatSessions) {
    const button = el(
      "button",
      `history-item${session.id === activeChatId ? " active" : ""}`,
      `<span class="history-title">${escapeHtml(chatTitle(session.messages))}</span>
       <span class="history-meta"><span>${escapeHtml(chatPreview(session.messages))}</span><span>${escapeHtml(relativeTime(session.updatedAt))}</span></span>`,
    );
    button.type = "button";
    button.addEventListener("click", () => openChat(session.id));
    historyList.appendChild(button);
  }
}

function setHistoryPanel(open) {
  if (!historyPanel || !historyToggleBtn) return;
  historyPanel.classList.toggle("hidden", !open);
  historyToggleBtn.classList.toggle("active", open);
}

function updateAutoApproveUi() {
  if (!autoApproveBtn) return;
  autoApproveBtn.classList.toggle("active", autoApprove);
  autoApproveBtn.title = autoApprove ? "Auto-approve actions on" : "Auto-approve actions off";
  autoApproveBtn.setAttribute("aria-label", autoApprove ? "Auto-approve actions on" : "Auto-approve actions off");
  if (composerHint) {
    composerHint.textContent = autoApprove
      ? "Auto-approve is on. The agent will act without asking first."
      : "Works best on public pages. You review every action before it runs.";
  }
}

async function persistChats() {
  await chrome.storage.local
    .set({
      [CHAT_STORAGE_KEY]: chatSessions.slice(0, MAX_STORED_CHATS),
      [CHAT_ACTIVE_KEY]: activeChatId,
      [AUTO_APPROVE_KEY]: autoApprove,
    })
    .catch(() => {});
}

async function saveActiveChat() {
  const idx = currentSessionIndex();
  const now = new Date().toISOString();
  const session = {
    id: activeChatId || newChatId(),
    createdAt: idx >= 0 ? chatSessions[idx].createdAt : now,
    updatedAt: now,
    messages: history.slice(),
  };
  activeChatId = session.id;
  if (idx >= 0) chatSessions[idx] = session;
  else chatSessions.unshift(session);
  chatSessions = chatSessions
    .filter((sessionItem, index, list) => list.findIndex((entry) => entry.id === sessionItem.id) === index)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_STORED_CHATS);
  renderHistoryList();
  await persistChats();
}

async function appendHistory(role, content) {
  history.push({ role, content });
  await saveActiveChat();
}

async function openChat(chatId) {
  const session = chatSessions.find((entry) => entry.id === chatId);
  if (!session) return;
  activeChatId = session.id;
  history.splice(0, history.length, ...session.messages.map((entry) => ({ ...entry })));
  clearChatView();
  for (const entry of history) renderSavedMessage(entry);
  renderHistoryList();
  setHistoryPanel(false);
  input.focus();
  await persistChats();
}

async function startNewChat() {
  const idx = currentSessionIndex();
  if (idx >= 0 && history.length === 0) {
    clearChatView();
    renderHistoryList();
    input.focus();
    return;
  }
  activeChatId = newChatId();
  history.splice(0);
  clearChatView();
  chatSessions.unshift({ id: activeChatId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] });
  chatSessions = chatSessions.slice(0, MAX_STORED_CHATS);
  renderHistoryList();
  setHistoryPanel(false);
  input.focus();
  await persistChats();
}

async function initChatMemory() {
  const stored = await chrome.storage.local.get([CHAT_STORAGE_KEY, CHAT_ACTIVE_KEY, AUTO_APPROVE_KEY]).catch(() => ({}));
  chatSessions = Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY].map(normalizeSession).filter(Boolean) : [];
  activeChatId = typeof stored[CHAT_ACTIVE_KEY] === "string" ? stored[CHAT_ACTIVE_KEY] : chatSessions[0]?.id || null;
  autoApprove = stored[AUTO_APPROVE_KEY] === true;
  updateAutoApproveUi();
  renderHistoryList();

  if (activeChatId && chatSessions.some((session) => session.id === activeChatId)) {
    await openChat(activeChatId);
    return;
  }
  await startNewChat();
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function recorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function cancelRecording() {
  const state = recordingState;
  if (!state) return;
  recordingState = null;
  try {
    state.recorder.stop();
  } catch {}
  try {
    state.stream.getTracks().forEach((track) => track.stop());
  } catch {}
  updateVoiceUi();
}

async function stopRecordingAndTranscribe() {
  if (!elevenLabsSettings) await loadElevenLabsSettings();
  const state = recordingState;
  if (!state) return;
  recordingState = null;
  updateVoiceUi();
  try {
    state.recorder.stop();
  } catch {}
  try {
    state.stream.getTracks().forEach((track) => track.stop());
  } catch {}
  const blob = await state.done;
  if (!blob || !blob.size) return;
  if (!elevenLabsSettings?.apiKey) {
    message("bot", '<p class="err">Set your ElevenLabs API key in Settings before using voice input.</p>');
    return;
  }
  voiceInputBtn.disabled = true;
  try {
    const transcript = await transcribeWithElevenLabs(blob, elevenLabsSettings);
    input.value = input.value ? `${input.value.trim()} ${transcript}` : transcript;
    autoGrowInput();
    input.focus();
  } catch (err) {
    message("bot", `<p class="err">Voice input failed: ${escapeHtml(err?.message || err)}</p>`);
  } finally {
    voiceInputBtn.disabled = false;
    updateVoiceUi();
  }
}

async function toggleRecording() {
  if (!elevenLabsSettings) await loadElevenLabsSettings();
  if (recordingState) {
    await stopRecordingAndTranscribe();
    return;
  }
  if (!elevenLabsSettings?.apiKey) {
    message("bot", '<p class="err">Set your ElevenLabs API key in Settings before using voice input.</p>');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    message("bot", '<p class="err">This browser does not support microphone recording here.</p>');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const mimeType = recorderMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const done = new Promise((resolve) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        resolve(new Blob(chunks, { type: chunks[0]?.type || mimeType || "audio/webm" }));
      }, { once: true });
    });
    recordingState = { recorder, stream, done };
    recorder.start();
    updateVoiceUi();
  } catch (err) {
    message("bot", `<p class="err">Couldn't start the microphone: ${escapeHtml(err?.message || err)}</p>`);
  }
}

async function readPageSnapshot(tab) {
  if (!tab?.id || !isHttpUrl(tab.url)) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const inferSchema = (value, depth = 0) => {
          if (typeof value === "boolean") return { type: "boolean" };
          if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
          if (typeof value === "string") return { type: "string" };
          if (value === null) return { type: "null" };
          if (Array.isArray(value)) return { type: "array" };
          if (typeof value === "object") {
            if (depth >= 1) return { type: "object" };
            const properties = {};
            for (const [key, nested] of Object.entries(value || {})) properties[key] = inferSchema(nested, depth + 1);
            return { type: "object", properties };
          }
          return {};
        };
        const cssEscape = (value) => {
          if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
          return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        };
        const selectorFor = (node) => {
          if (!(node instanceof Element)) return "";
          if (node.id) return `#${cssEscape(node.id)}`;
          const attr = node.getAttribute("name") || node.getAttribute("aria-label") || node.getAttribute("placeholder");
          if (attr) return `${node.tagName.toLowerCase()}[${node.getAttribute("name") ? "name" : node.getAttribute("aria-label") ? "aria-label" : "placeholder"}="${attr.replace(/"/g, '\\"')}"]`;
          const path = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 5) {
            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            path.unshift(part);
            current = parent;
          }
          return path.join(" > ");
        };
        const isVisible = (node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const outline = Array.from(document.querySelectorAll("h1,h2,h3"))
          .filter(isVisible)
          .slice(0, 24)
          .map((node) => `${node.tagName.toLowerCase()}: ${clean(node.textContent).slice(0, 120)}`)
          .filter(Boolean);
        const actions = Array.from(
          document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"]'),
        )
          .filter(isVisible)
          .slice(0, 48)
          .map((node) => {
            const tag = node.getAttribute("role") || node.tagName.toLowerCase();
            const label = clean(
              node.innerText ||
                node.getAttribute("aria-label") ||
                node.getAttribute("placeholder") ||
                node.getAttribute("name") ||
                node.getAttribute("id") ||
                node.getAttribute("href") ||
                node.getAttribute("type"),
            );
            return label ? `${tag}: ${label.slice(0, 120)}` : "";
          })
          .filter(Boolean);
        const actionItems = Array.from(
          document.querySelectorAll('a[href],button,input[type="button"],input[type="submit"],select,[role="button"],[role="link"],[role="menuitem"]'),
        )
          .filter(isVisible)
          .slice(0, 60)
          .map((node) => {
            const selector = selectorFor(node);
            const label = clean(
              node.innerText ||
              node.getAttribute("aria-label") ||
              node.getAttribute("placeholder") ||
              node.getAttribute("name") ||
              node.getAttribute("id") ||
              node.getAttribute("value"),
            );
            if (!selector || !label) return null;
            const role = node.getAttribute("role");
            const kind =
              node.tagName === "A" ? "link" :
              node.tagName === "SELECT" ? "select" :
              role === "menuitem" ? "menuitem" :
              node.tagName === "INPUT" ? "input" : "button";
            const href = node instanceof HTMLAnchorElement ? node.href : undefined;
            return { kind, label: label.slice(0, 120), selector, href };
          })
          .filter(Boolean);

        const forms = Array.from(document.forms)
          .filter(isVisible)
          .slice(0, 16)
          .map((form) => {
            const selector = selectorFor(form);
            if (!selector) return null;
            const fields = Array.from(form.elements)
              .filter((node) => node instanceof HTMLElement)
              .map((node) => {
                const input = node;
                const name = input.getAttribute?.("name");
                if (!name) return null;
                const type = (input.getAttribute?.("type") || input.tagName || "text").toLowerCase();
                if (["hidden", "password", "submit", "button", "reset", "file"].includes(type)) return null;
                const label = input.id ? clean(document.querySelector(`label[for="${cssEscape(input.id)}"]`)?.textContent || "") : "";
                return {
                  name,
                  type,
                  label: label || undefined,
                  placeholder: input.getAttribute?.("placeholder") || undefined,
                  required: input.hasAttribute?.("required") || /search|query|keyword|term|q|k/i.test(name),
                  selector: selectorFor(input),
                };
              })
              .filter(Boolean)
              .slice(0, 12);
            if (!fields.length) return null;
            const submit = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
            const purpose = fields.some((field) => /search|query|keyword|term|q|k/i.test(field.name) || field.type === "search")
              ? "search"
              : fields.some((field) => field.type === "checkbox" || field.type === "radio" || field.type === "select")
                ? "filter"
                : Array.from(form.elements).some((node) => /password/i.test(node.getAttribute?.("type") || ""))
                  ? "auth"
                  : "form";
            return {
              selector,
              method: (form.getAttribute("method") || "GET").toUpperCase() === "POST" ? "POST" : "GET",
              action: form.action || undefined,
              purpose,
              submitLabel: submit ? clean(submit.innerText || submit.getAttribute("aria-label") || submit.getAttribute("value") || "") || undefined : undefined,
              submitSelector: submit ? selectorFor(submit) : undefined,
              fields,
            };
          })
          .filter(Boolean);

        const appState = [];
        const scriptCandidates = Array.from(document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"],script#__NEXT_DATA__,script#__NUXT_DATA__'))
          .slice(0, 12);
        for (const script of scriptCandidates) {
          const source = script.id || script.getAttribute("type") || "script";
          const text = script.textContent?.trim();
          if (!text || text.length > 200000) continue;
          try {
            const data = JSON.parse(text);
            const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : undefined;
            const types = [];
            const collectTypes = (value) => {
              if (!value || typeof value !== "object") return;
              if (Array.isArray(value)) return value.slice(0, 8).forEach(collectTypes);
              const type = value["@type"];
              if (typeof type === "string" && !types.includes(type)) types.push(type);
              for (const nested of Object.values(value).slice(0, 30)) collectTypes(nested);
            };
            collectTypes(data);
            appState.push({ source, keys, schema: inferSchema(data), types: types.slice(0, 10) || undefined });
          } catch {
            /* ignore malformed inline data */
          }
        }

        const selectorNodes = Array.from(
          document.querySelectorAll('form,input[type="search"],input[name],button,a[href],select,textarea,[role="button"],[role="link"]'),
        )
          .filter(isVisible)
          .slice(0, 80);
        const selectorsOfInterest = selectorNodes
          .map((node) => {
            const selector = selectorFor(node);
            if (!selector) return null;
            const role = node.getAttribute("role") || node.getAttribute("type") || node.tagName.toLowerCase();
            const fallbackSelectors = [];
            if (node.getAttribute("name")) fallbackSelectors.push(`${node.tagName.toLowerCase()}[name="${node.getAttribute("name").replace(/"/g, '\\"')}"]`);
            if (node.getAttribute("aria-label")) fallbackSelectors.push(`${node.tagName.toLowerCase()}[aria-label="${node.getAttribute("aria-label").replace(/"/g, '\\"')}"]`);
            return { role, selector, fallbackSelectors: fallbackSelectors.length ? fallbackSelectors : undefined };
          })
          .filter(Boolean);

        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,video,audio").forEach((node) => node.remove());
        clone.querySelectorAll('input[type="hidden"],input[type="password"],[name*="token" i],[name*="secret" i],[name*="password" i],[name*="session" i]').forEach((node) => node.remove());
        clone.querySelectorAll("input,textarea").forEach((node) => {
          node.removeAttribute("value");
          node.textContent = "";
        });
        clone.querySelectorAll("*").forEach((node) => {
          for (const attr of Array.from(node.attributes)) {
            if (/^(on|srcdoc$)/i.test(attr.name) || /token|secret|password|session|cookie|auth/i.test(attr.name)) {
              node.removeAttribute(attr.name);
            }
          }
        });

        return {
          title: document.title,
          url: location.href,
          outline,
          actions,
          actionItems,
          forms,
          appState,
          selectorsOfInterest,
          html: clone.outerHTML.slice(0, 120000),
          visibleText: clean(document.body?.innerText || "").slice(0, 8000),
        };
      },
    });
    return result?.result || null;
  } catch {
    return null;
  }
}

function isSecretName(name) {
  const normalized = String(name || "").toLowerCase();
  return (
    ["token", "secret", "password", "session", "auth", "cookie"].some((part) => normalized.includes(part)) ||
    normalized === "key" ||
    normalized === "apikey" ||
    normalized === "api_key" ||
    normalized === "api-key" ||
    normalized.endsWith("_key") ||
    normalized.endsWith("-key")
  );
}

function sanitizedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSecretName(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function scrubUrl(rawUrl) {
  return truncate(sanitizedUrl(rawUrl) || rawUrl, 220);
}

async function readCapturedCalls(tab) {
  if (!tab?.id) return [];
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-capture", tabId: tab.id });
    return response?.calls || [];
  } catch {
    return [];
  }
}

async function readRecentCalls(tab) {
  return (await readCapturedCalls(tab)).slice(-20).map((call) => {
    const contentType = call.contentType ? ` ${call.contentType.split(";")[0]}` : "";
    return `${call.method || "GET"} ${scrubUrl(call.url)} -> ${call.status || "?"}${contentType}`;
  });
}

async function buildPageContext() {
  const tab = await activeTab().catch(() => null);
  const [snapshot, recentCalls] = await Promise.all([readPageSnapshot(tab), readRecentCalls(tab)]);

  const sections = [];
  if (snapshot?.outline?.length) sections.push(`Page outline:\n${snapshot.outline.map((line) => `- ${line}`).join("\n")}`);
  if (snapshot?.actions?.length) sections.push(`Visible actions:\n${snapshot.actions.map((line) => `- ${line}`).join("\n")}`);
  if (snapshot?.visibleText) sections.push(`Visible text:\n${snapshot.visibleText}`);
  if (recentCalls.length) sections.push(`Recent XHR/fetch calls captured by the extension:\n${recentCalls.map((line) => `- ${line}`).join("\n")}`);

  const context = {};
  if (isHttpUrl(tab?.url)) context.url = sanitizedUrl(tab.url);
  if (tab?.title || snapshot?.title) context.title = tab?.title || snapshot.title;
  if (sections.length) context.visibleText = truncate(sections.join("\n\n"), 11500);
  return context;
}

async function buildExtensionBundle(tab) {
  const [snapshot, calls] = await Promise.all([readPageSnapshot(tab), readCapturedCalls(tab)]);
  if (!snapshot?.html) return null;
  const pageUrl = sanitizedUrl(tab?.url || snapshot.url);
  if (!pageUrl) return null;
  return buildCaptureBundle({
    url: pageUrl,
    html: snapshot.html,
    title: tab?.title || snapshot.title,
    selectorsOfInterest: snapshot.selectorsOfInterest || [],
    calls,
    page: {
      headings: snapshot.outline || [],
      visibleText: snapshot.visibleText || undefined,
      actions: snapshot.actionItems || [],
      forms: snapshot.forms || [],
      appState: snapshot.appState || [],
    },
    legalMode: "session",
  });
}

// Human-readable label for a browsing tool call (shown as an activity row / in the confirm card).
function toolActionLabel(call) {
  const a = call.arguments || {};
  switch (call.name) {
    case "browser_snapshot": return "Read the page";
    case "browser_navigate": return `Navigate to ${a.url}`;
    case "browser_click": return `Click ${a.ref}`;
    case "browser_type": return `Type “${a.text}”${a.submit ? " and submit" : ""} into ${a.ref}`;
    case "browser_select_option": return `Select “${a.value}” in ${a.ref}`;
    case "browser_back": return "Go back";
    case "browser_read_page": return "Read page text";
    case "browser_extract": return `Extract ${a.mode || "metadata"}`;
    default: return call.name;
  }
}

// A running view inside the bot bubble: assistant prose, tool-activity rows, and inline confirm cards.
function agentView(body) {
  body.innerHTML = '<div class="agent-steps"></div>';
  const steps = body.querySelector(".agent-steps");
  return {
    addText(text) {
      const node = el("div", "agent-say");
      node.innerHTML = renderMarkdown(text);
      steps.appendChild(node);
      scrollToBottom();
    },
    addTool(call) {
      const row = el("div", "agent-tool", `<span class="agent-tool-label">${escapeHtml(toolActionLabel(call))}</span><span class="agent-tool-state">…</span>`);
      steps.appendChild(row);
      scrollToBottom();
      return row;
    },
    settleTool(row, state) {
      if (!row) return;
      const node = row.querySelector(".agent-tool-state");
      if (node) node.textContent = state;
    },
    confirm(call, signal) {
      return new Promise((resolve) => {
        const card = el("div", "agent-confirm");
        card.innerHTML = `<p class="agent-confirm-q">Run this action on the live page?</p><p class="agent-confirm-what">${escapeHtml(toolActionLabel(call))}</p>`;
        const ok = el("button", "mini-btn primary");
        ok.type = "button";
        ok.textContent = "Confirm";
        const skip = el("button", "mini-btn");
        skip.type = "button";
        skip.textContent = "Skip";
        const row = el("div", "arow");
        row.append(ok, skip);
        card.appendChild(row);
        steps.appendChild(card);
        scrollToBottom();
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          ok.disabled = skip.disabled = true;
          card.classList.add(value ? "confirmed" : "declined");
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        function onAbort() { finish(false); }
        if (signal) {
          if (signal.aborted) return finish(false);
          signal.addEventListener("abort", onAbort);
        }
        ok.addEventListener("click", () => finish(true));
        skip.addEventListener("click", () => finish(false));
      });
    },
  };
}

// ── Continuous discovery: as the agent drives a reactive page, capture fresh structure and run the
// token-efficient incremental engine (server-side). New tools become callable BY THE AGENT this session
// (sessionTools) and also grow the persisted server when one exists. Debounced + deduped by (url, XHR count)
// so we don't spam the API; the server skips the model entirely when nothing's new. ──
const discovery = { serverId: undefined, resolvedFor: undefined, lastSig: "", timer: null, busy: false, agentActive: false, sessionTools: [] };

function bundleSignature(bundle) {
  return [
    bundle?.url || "",
    bundle?.dom?.domHash || "",
    bundle?.network?.length || 0,
    bundle?.page?.forms?.length || 0,
    bundle?.page?.actions?.length || 0,
    bundle?.page?.appState?.length || 0,
  ].join("|");
}

function scheduleDiscovery() {
  if (discovery.timer) clearTimeout(discovery.timer);
  discovery.timer = setTimeout(() => {
    runDiscovery().catch(() => {});
  }, 1600);
}

async function discoverFromBundle(bundle, { allowDuringAgent = false, announce = true, announcer } = {}) {
  if (!bundle) return { added: [], tools: discovery.sessionTools };
  const sig = bundleSignature(bundle);
  if (sig === discovery.lastSig) return { added: [], tools: discovery.sessionTools };
  discovery.lastSig = sig;

  discovery.busy = true;
  try {
    const { added, tools } = await discoverTools(discovery.sessionTools, bundle, discovery.serverId);
    if (Array.isArray(tools)) discovery.sessionTools = tools;
    if (Array.isArray(added) && added.length && announce) {
      const note = `Found ${added.length} new tool${added.length === 1 ? "" : "s"} for this page: ${added.map((t) => `\`${t.name}\``).join(", ")}. I can use ${added.length === 1 ? "it" : "them"} now.`;
      if (typeof announcer === "function") announcer(note, added);
      else message("bot", `<p class="sub">${added.length} new tool${added.length === 1 ? "" : "s"}: ${added.map((t) => `<code>${escapeHtml(t.name)}</code>`).join(", ")}.</p>`);
    }
    return { added: Array.isArray(added) ? added : [], tools: discovery.sessionTools };
  } catch {
    return { added: [], tools: discovery.sessionTools };
  } finally {
    discovery.busy = false;
  }
}

async function runDiscovery() {
  // Don't compete with the agent mid-turn (extra /api/discover + model calls slow the loop). It re-runs
  // once the turn ends.
  if (discovery.busy || discovery.agentActive) return;
  const tab = await activeTab().catch(() => null);
  if (!isHttpUrl(tab?.url)) return;
  const url = sanitizedUrl(tab.url);

  if (discovery.resolvedFor !== url) {
    discovery.resolvedFor = url;
    discovery.serverId = undefined;

    // Pull pre-cached tools from Atlas first — instant, no generation needed.
    if (atlasSettings) {
      const record = await fetchToolsFromAtlas(url, atlasSettings).catch(() => null);
      if (record?.serverId) discovery.serverId = record.serverId;
      if (Array.isArray(record?.tools) && record.tools.length) {
        const known = new Set(discovery.sessionTools.map((t) => t.name));
        const fresh = record.tools.filter((t) => t && t.name && t.execution && !known.has(t.name));
        if (fresh.length) {
          discovery.sessionTools = [...discovery.sessionTools, ...fresh];
          message("bot", `<p class="sub">${fresh.length} tool${fresh.length === 1 ? "" : "s"} loaded from Atlas for <strong>${escapeHtml(new URL(url).hostname)}</strong>.</p>`);
        }
      }
    }

    if (!discovery.serverId) {
      discovery.serverId = await findServerForUrl(url).catch(() => undefined);
    }
  }

  const bundle = await buildExtensionBundle(tab).catch(() => null);
  if (!bundle) return;
  await discoverFromBundle(bundle);
}

function toolMayExposeNewPageState(call, def) {
  if (def?.execution?.kind === "browser") return true;
  if (def?.execution?.kind === "http") return String(def.execution.request?.method || "GET").toUpperCase() === "GET" || needsConfirmDiscoveredTool(def, "https://example.invalid", call?.arguments);
  return new Set([
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_select_option",
    "browser_press_key",
    "browser_back",
  ]).has(call?.name);
}

async function discoverInlineAfterAction(call, def, announce) {
  if (discovery.busy || !toolMayExposeNewPageState(call, def)) return;
  const tab = await activeTab().catch(() => null);
  if (!isHttpUrl(tab?.url)) return;
  const url = sanitizedUrl(tab.url);
  if (discovery.resolvedFor !== url) {
    discovery.resolvedFor = url;
    discovery.serverId = await findServerForUrl(url).catch(() => undefined);
  }
  const bundle = await buildExtensionBundle(tab).catch(() => null);
  if (!bundle) return;
  await discoverFromBundle(bundle, { allowDuringAgent: true, announce: true, announcer: announce });
}

// Execute a discovered generated-server tool live, ON THE PAGE THE USER IS LOOKING AT — not headless.
// A GET tool (search, view a product, list results) NAVIGATES the current tab to that URL so the user
// watches it happen. Only state-changing requests (POST/PUT/…) run as a background request against their
// logged-in session (and those are confirmed first). Browser-step tools defer to the visible primitives.
async function executeDiscovered(def, args, tabExecute) {
  if (def?.execution?.kind === "http") {
    const { url, init } = httpRequestFromTool(def.execution, args || {});
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET") {
      // visible: drive the current tab to the result rather than fetching it invisibly
      return tabExecute({ name: "browser_navigate", arguments: { url } });
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      const body = text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text;
      return `Done (${res.status}) ${def.name}. ${body}`;
    } catch (err) {
      return `Request failed for ${def.name}: ${err?.message || err}`;
    }
  }
  if (def?.execution?.kind === "browser") {
    return executeBrowserStepsOnActiveTab(def.execution.steps || [], args || {});
  }
  return `Unsupported tool execution for ${def?.name || "unknown tool"}.`;
}

async function sendChat(text) {
  const prompt = text.trim();
  if (!prompt || activeAbort) return;

  input.value = "";
  autoGrowInput();
  message("user", `<p>${escapeHtml(prompt)}</p>`);
  await appendHistory("user", prompt);

  const pending = message("bot", typingHtml());
  const controller = new AbortController();
  const signal = { aborted: false };
  controller.signal.addEventListener("abort", () => (signal.aborted = true));
  activeAbort = controller;
  setBusy(true);
  discovery.agentActive = true; // pause background discovery while the agent is driving

  const view = agentView(pending.body);
  const tabExecute = makeTabExecutor();
  const findDiscovered = (name) => discovery.sessionTools.find((t) => t.name === name);
  let activeRow = null;

  try {
    const pageContext = await buildPageContext();
    const outcome = await runAgent(history.slice(), {
      // Recompute specs each step so tools discovered mid-turn become callable immediately (browser_*
      // primitives + whatever discovered tools exist for this page right now).
      step: (messages) =>
        assistAgentStep(
          messages,
          pageContext,
          [...BROWSER_TOOL_SPECS, ...discoveredToolSpecs(discovery.sessionTools)],
          controller.signal,
        ).then(parseStepResponse),
      execute: async (call) => {
        const def = findDiscovered(call.name);
        const result = def ? await executeDiscovered(def, call.arguments, tabExecute) : await tabExecute(call);
        await discoverInlineAfterAction(call, def, (html) => view.addText(html));
        return result;
      },
      confirm: (call) => view.confirm(call, controller.signal),
      // Confirm built-in mutating primitives/off-origin nav AND discovered tools that click/type/select or
      // navigate off-origin on the user's live tab.
      needsConfirm: (call, url) => {
        if (autoApprove) return false;
        if (needsConfirm(call, url)) return true;
        const def = findDiscovered(call.name);
        return def ? needsConfirmDiscoveredTool(def, url, call.arguments) : false;
      },
      currentUrl: async () => {
        const tab = await activeTab().catch(() => null);
        return tab?.url || pageContext.url || "";
      },
      onText: (text) => view.addText(text),
      // Always show an activity row; mutating/off-origin actions ALSO get a Confirm/Skip card from confirm()
      // (the real gate lives in runAgent against the live URL, so we don't second-guess it here).
      onToolStart: (call) => {
        activeRow = view.addTool(call);
      },
      onToolResult: (_call, _result, skipped) => {
        if (activeRow) view.settleTool(activeRow, skipped ? "skipped" : "done");
        activeRow = null;
      },
      signal,
      maxSteps: 18,
    });
    // Persist only the final assistant answer across turns (tool results stay within the turn to avoid bloat).
    if (outcome.finalText) {
      await appendHistory("assistant", outcome.finalText);
      if (elevenLabsSettings?.autoSpeak) playAssistantReply(outcome.finalText).catch(() => {});
    }
  } catch (err) {
    if (err?.name === "AbortError" || signal.aborted) {
      view.addText("_Stopped._");
    } else {
      view.addText(`Couldn't reach the assistant. Is the web app running? (${escapeHtml(err?.message || err)})`);
    }
  } finally {
    setBusy(false);
    discovery.agentActive = false;
    scheduleDiscovery(); // now that the page has settled, look once for newly-exposed tools
    scrollToBottom();
    input.focus();
  }
}

async function generateServer() {
  if (activeAbort) activeAbort.abort();
  const tab = await activeTab();
  if (!isHttpUrl(tab?.url)) {
    message("bot", `<p class="err">Open an http or https page before generating an MCP server.</p>`);
    return;
  }

  const target = tab.title || tab.url;
  const generateUrl = sanitizedUrl(tab.url);
  const redactedUrl = generateUrl !== tab.url;
  message("user", `<p>Make an MCP server for <strong>${escapeHtml(target)}</strong></p>`);
  await appendHistory("user", `Make an MCP server for ${target}`);
  const pending = message(
    "bot",
    `<p>Preparing generation... <span class="sub" data-status>queued</span></p>${
      redactedUrl ? '<p class="sub">Sensitive URL parameters were redacted before sending this request.</p>' : ""
    }${typingHtml("Generating")}`,
  );

  try {
    const captureBundle = await buildExtensionBundle(tab);
    const statusEl = pending.body.querySelector("[data-status]");
    if (statusEl && captureBundle) {
      statusEl.textContent = `captured ${captureBundle.network.length} request${captureBundle.network.length === 1 ? "" : "s"}`;
    }
    const { jobId } = await generate(generateUrl, captureBundle ? "session" : "safe", captureBundle);
    if (statusEl) statusEl.textContent = `job ${jobId.slice(0, 8)}...`;
    const artifact = await waitForArtifact(jobId, {
      onTick: (status) => {
        const node = pending.body.querySelector("[data-status]");
        if (node) node.textContent = status;
      },
    });
    const { html, toolNames } = artifactHtml(artifact, tab);
    pending.body.innerHTML = html;
    wireArtifact(pending.wrapper, artifact, tab);
    await appendHistory("assistant", `Generated MCP server v${artifact.version} for ${target}. Tools: ${toolNames.join(", ") || "none detected"}.`);
    if (atlasSettings && Array.isArray(artifact.tools) && artifact.tools.length) {
      saveToolsToAtlas(generateUrl, {
        serverId: artifact.serverId,
        tools: artifact.tools,
        version: artifact.version,
        title: tab.title || tab.url,
      }, atlasSettings).catch(() => {});
    }
    // A server now exists for this page, so let continuous discovery resolve it and grow it as you browse.
    discovery.resolvedFor = undefined;
    discovery.lastSig = "";
    scheduleDiscovery();
  } catch (err) {
    pending.body.innerHTML = `<p class="err">Generation failed: ${escapeHtml(err?.message || err)}</p><p class="sub">Make sure the web app, worker, and scraper are running.</p>`;
    await appendHistory("assistant", `Generation failed for ${target}: ${err?.message || err}`);
  }
  scrollToBottom();
}

function extractToolNames(serverTs) {
  if (!serverTs?.content) return [];
  return [...serverTs.content.matchAll(/register\(\s*"([^"]+)"/g)].map((match) => match[1]);
}

function artifactHtml(artifact, tab) {
  const files = artifact.files || [];
  const serverTs = files.find((file) => file.path === "server.ts");
  const config = artifact.configSnippet || files.find((file) => file.path === "claude_desktop_config.json")?.content || "{}";
  const toolNames = extractToolNames(serverTs);
  const toolsHtml = toolNames.length
    ? toolNames.map((name) => `<span class="tool-tag">${escapeHtml(name)}</span>`).join("")
    : '<span class="sub">No registered tools found in server.ts.</span>';

  return {
    toolNames,
    html: `
      <div class="artifact">
        <div class="artifact-top">
          <p><span class="ok">Built tools</span> for <strong>${escapeHtml(tab.title || tab.url)}</strong> (v${escapeHtml(artifact.version)})</p>
          <div class="tools">${toolsHtml}</div>
        </div>
        <div class="atabs" role="tablist" aria-label="Generated artifact files">
          <button class="atab active" data-k="config" type="button">Config snippet</button>
          <button class="atab" data-k="server" type="button">server.ts</button>
        </div>
        <pre class="acode" data-k="config">${escapeHtml(config)}</pre>
        <pre class="acode hidden" data-k="server">${escapeHtml(serverTs ? serverTs.content : "(no server.ts)")}</pre>
        <div class="arow">
          <button class="mini-btn primary" data-act="apply" type="button">Use in this chat</button>
          <button class="mini-btn" data-act="copy" type="button">Copy current</button>
          <button class="mini-btn" data-act="download" type="button">Download bundle</button>
        </div>
      </div>
      <p class="sub"><strong>Use in this chat</strong> to do things on this page right here, no install needed. Or download the files to run these tools in another AI app (you build them locally first).</p>
    `,
  };
}

function wireArtifact(card, artifact, tab) {
  const show = (key) => {
    card.querySelectorAll(".atab").forEach((button) => button.classList.toggle("active", button.dataset.k === key));
    card.querySelectorAll(".acode").forEach((code) => code.classList.toggle("hidden", code.dataset.k !== key));
  };
  card.querySelectorAll(".atab").forEach((button) => button.addEventListener("click", () => show(button.dataset.k)));
  const applyBtn = card.querySelector('[data-act="apply"]');
  if (applyBtn) applyBtn.addEventListener("click", () => applyServer(card, artifact, tab));
  card.querySelector('[data-act="copy"]').addEventListener("click", async (event) => {
    const visible = card.querySelector(".acode:not(.hidden)");
    await copyText(visible?.textContent || "");
    const button = event.currentTarget;
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1200);
  });
  card.querySelector('[data-act="download"]').addEventListener("click", () => downloadFiles(artifact, tab));
}

/**
 * "Apply": make a generated server usable RIGHT HERE by loading its tools into the side-panel agent so you can
 * drive the page by chatting, no install/export. The executable site tools are the HTTP ones (run via fetch
 * on your logged-in session); browser-step tools are already covered by the agent's built-in browser_*
 * primitives, so we don't double them. Also points continuous discovery at this server so it keeps growing.
 */
function applyServer(card, artifact, tab) {
  const defs = Array.isArray(artifact.tools) ? artifact.tools : [];
  const httpTools = defs.filter((d) => d && d.name && d.execution && d.execution.kind === "http");
  const known = new Set(discovery.sessionTools.map((t) => t.name));
  discovery.sessionTools = [...discovery.sessionTools, ...httpTools.filter((d) => !known.has(d.name))];
  discovery.serverId = artifact.serverId;
  if (isHttpUrl(tab?.url)) discovery.resolvedFor = sanitizedUrl(tab.url);

  const applyBtn = card.querySelector('[data-act="apply"]');
  if (applyBtn) {
    applyBtn.textContent = "Applied ✓";
    applyBtn.disabled = true;
  }

  const names = discovery.sessionTools.map((t) => t.name);
  const toolList = names.length ? names.map((n) => `<code>${escapeHtml(n)}</code>`).join(", ") + ", plus " : "";
  message(
    "bot",
    `<p class="ok">Ready. You can use these tools right here by chatting.</p><p class="sub">I can now use ${toolList}navigate, click, type, and read on the page. Try: <em>"search for wireless headphones and open the first result"</em>. I'll ask you to confirm before anything that changes your account, like add to cart.</p>`,
  );
  input.focus();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function downloadFiles(artifact, tab) {
  const root = artifactRootName(artifact, tab);
  const blob = zipBlob(artifact.files || [], root);
  const url = URL.createObjectURL(blob);
  const filename = `${root}.zip`;
  if (chrome.downloads?.download) {
    chrome.downloads.download({ url, filename }, () => setTimeout(() => URL.revokeObjectURL(url), 30000));
    return;
  }
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function artifactRootName(artifact, tab) {
  const base = cleanText(artifact?.title || tab?.title || tab?.url || "mcp-server")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const version = artifact?.version ? `-v${artifact.version}` : "";
  return `${base || "mcp-server"}${version}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat(input.value);
});

sendBtn.addEventListener("click", (event) => {
  if (!activeAbort) return;
  event.preventDefault();
  activeAbort.abort();
});
voiceInputBtn.addEventListener("click", (event) => {
  event.preventDefault();
  toggleRecording();
});
speakReplyBtn.addEventListener("click", (event) => {
  event.preventDefault();
  playAssistantReply().catch(() => {});
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendChat(input.value);
  }
});
input.addEventListener("input", autoGrowInput);

genBtn.addEventListener("click", generateServer);
newChatBtn.addEventListener("click", () => startNewChat());
historyToggleBtn.addEventListener("click", () => setHistoryPanel(historyPanel.classList.contains("hidden")));
autoApproveBtn.addEventListener("click", async () => {
  autoApprove = !autoApprove;
  updateAutoApproveUi();
  await persistChats();
});
themeBtn.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendChat(button.dataset.q || button.textContent || ""));
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if (keys.some((key) => key.startsWith("elevenLabs"))) loadElevenLabsSettings().catch(() => {});
  if (keys.some((key) => key.startsWith("atlas"))) loadAtlasSettings().catch(() => {});
});

initPageTitle();
initTheme();
syncConfigFromServer().finally(() => {
  loadElevenLabsSettings();
  loadAtlasSettings();
});
initChatMemory();
autoGrowInput();
updateVoiceUi();
