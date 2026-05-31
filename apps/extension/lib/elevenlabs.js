export const ELEVENLABS_STORAGE_KEYS = {
  apiKey: "elevenLabsApiKey",
  voiceId: "elevenLabsVoiceId",
  ttsModel: "elevenLabsTtsModel",
  sttModel: "elevenLabsSttModel",
  autoSpeak: "elevenLabsAutoSpeak",
};

export const ELEVENLABS_DEFAULTS = {
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  ttsModel: "eleven_multilingual_v2",
  sttModel: "scribe_v2",
  autoSpeak: false,
};

function trim(value) {
  return String(value ?? "").trim();
}

function audioExt(mimeType) {
  const type = String(mimeType || "");
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

function parseErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.detail?.message || parsed?.detail || parsed?.message || text;
  } catch {
    return text;
  }
}

export function normalizeElevenLabsSettings(stored = {}) {
  return {
    apiKey: trim(stored[ELEVENLABS_STORAGE_KEYS.apiKey]),
    voiceId: trim(stored[ELEVENLABS_STORAGE_KEYS.voiceId]) || ELEVENLABS_DEFAULTS.voiceId,
    ttsModel: trim(stored[ELEVENLABS_STORAGE_KEYS.ttsModel]) || ELEVENLABS_DEFAULTS.ttsModel,
    sttModel: trim(stored[ELEVENLABS_STORAGE_KEYS.sttModel]) || ELEVENLABS_DEFAULTS.sttModel,
    autoSpeak: stored[ELEVENLABS_STORAGE_KEYS.autoSpeak] === true,
  };
}

export async function getElevenLabsSettings() {
  const stored = await chrome.storage.local.get(Object.values(ELEVENLABS_STORAGE_KEYS)).catch(() => ({}));
  return normalizeElevenLabsSettings(stored);
}

export async function setElevenLabsSettings(settings) {
  await chrome.storage.local.set({
    [ELEVENLABS_STORAGE_KEYS.apiKey]: trim(settings.apiKey),
    [ELEVENLABS_STORAGE_KEYS.voiceId]: trim(settings.voiceId) || ELEVENLABS_DEFAULTS.voiceId,
    [ELEVENLABS_STORAGE_KEYS.ttsModel]: trim(settings.ttsModel) || ELEVENLABS_DEFAULTS.ttsModel,
    [ELEVENLABS_STORAGE_KEYS.sttModel]: trim(settings.sttModel) || ELEVENLABS_DEFAULTS.sttModel,
    [ELEVENLABS_STORAGE_KEYS.autoSpeak]: settings.autoSpeak === true,
  });
}

export function speakableText(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/[*_#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribeWithElevenLabs(blob, settings) {
  if (!settings?.apiKey) throw new Error("Set your ElevenLabs API key in Settings first.");
  const form = new FormData();
  form.append("model_id", settings.sttModel || ELEVENLABS_DEFAULTS.sttModel);
  const mimeType = blob.type || "audio/webm";
  form.append("file", new File([blob], `prompt.${audioExt(mimeType)}`, { type: mimeType }));

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": settings.apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs transcription failed (${res.status}): ${parseErrorBody(text) || "unknown error"}`);
  }
  const data = await res.json().catch(() => null);
  const text = trim(data?.text);
  if (!text) throw new Error("ElevenLabs returned an empty transcript.");
  return text;
}

export async function synthesizeWithElevenLabs(text, settings) {
  if (!settings?.apiKey) throw new Error("Set your ElevenLabs API key in Settings first.");
  const clean = speakableText(text);
  if (!clean) throw new Error("Nothing to speak.");

  const query = new URLSearchParams({ output_format: "mp3_44100_128" });
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voiceId || ELEVENLABS_DEFAULTS.voiceId)}?${query}`, {
    method: "POST",
    headers: {
      "xi-api-key": settings.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: clean,
      model_id: settings.ttsModel || ELEVENLABS_DEFAULTS.ttsModel,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs speech failed (${res.status}): ${parseErrorBody(body) || "unknown error"}`);
  }
  return res.blob();
}
