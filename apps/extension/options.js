import { DEFAULT_API_BASE } from "./lib/config.js";
import { ELEVENLABS_DEFAULTS, getElevenLabsSettings, setElevenLabsSettings } from "./lib/elevenlabs.js";
import { ATLAS_DEFAULTS, getAtlasSettings, setAtlasSettings } from "./lib/atlas.js";

const api = document.getElementById("api");
const elevenApiKey = document.getElementById("elevenApiKey");
const elevenVoiceId = document.getElementById("elevenVoiceId");
const elevenTtsModel = document.getElementById("elevenTtsModel");
const elevenSttModel = document.getElementById("elevenSttModel");
const elevenAutoSpeak = document.getElementById("elevenAutoSpeak");
const atlasEndpoint = document.getElementById("atlasEndpoint");
const atlasApiKey = document.getElementById("atlasApiKey");
const atlasDataSource = document.getElementById("atlasDataSource");
const atlasDatabase = document.getElementById("atlasDatabase");
const atlasCollection = document.getElementById("atlasCollection");
const status = document.getElementById("status");
const LEGACY_DEFAULT_API_BASES = new Set(["http://localhost:3000"]);

function normalizeApiBase(value) {
  const base = String(value || "").replace(/\/$/, "");
  return !base || LEGACY_DEFAULT_API_BASES.has(base) ? DEFAULT_API_BASE : base;
}

api.placeholder = DEFAULT_API_BASE;

chrome.storage.sync.get("apiBase").then(({ apiBase }) => {
  api.value = normalizeApiBase(apiBase);
});

getElevenLabsSettings().then((settings) => {
  elevenApiKey.value = settings.apiKey || "";
  elevenVoiceId.value = settings.voiceId || ELEVENLABS_DEFAULTS.voiceId;
  elevenTtsModel.value = settings.ttsModel || ELEVENLABS_DEFAULTS.ttsModel;
  elevenSttModel.value = settings.sttModel || ELEVENLABS_DEFAULTS.sttModel;
  elevenAutoSpeak.checked = settings.autoSpeak === true;
});

getAtlasSettings().then((settings) => {
  atlasEndpoint.value = settings.endpoint || "";
  atlasApiKey.value = settings.apiKey || "";
  atlasDataSource.value = settings.dataSource || ATLAS_DEFAULTS.dataSource;
  atlasDatabase.value = settings.database || ATLAS_DEFAULTS.database;
  atlasCollection.value = settings.collection || ATLAS_DEFAULTS.collection;
});

document.getElementById("save").addEventListener("click", async () => {
  const value = normalizeApiBase(api.value);
  await chrome.storage.sync.set({ apiBase: value });
  await setElevenLabsSettings({
    apiKey: elevenApiKey.value,
    voiceId: elevenVoiceId.value,
    ttsModel: elevenTtsModel.value,
    sttModel: elevenSttModel.value,
    autoSpeak: elevenAutoSpeak.checked,
  });
  await setAtlasSettings({
    endpoint: atlasEndpoint.value,
    apiKey: atlasApiKey.value,
    dataSource: atlasDataSource.value,
    database: atlasDatabase.value,
    collection: atlasCollection.value,
  });
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
});
