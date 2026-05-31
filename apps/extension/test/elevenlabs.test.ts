import { test } from "node:test";
import assert from "node:assert/strict";

import { ELEVENLABS_DEFAULTS, normalizeElevenLabsSettings, speakableText } from "../lib/elevenlabs.js";

test("normalizeElevenLabsSettings applies defaults and trims values", () => {
  const settings = normalizeElevenLabsSettings({
    elevenLabsApiKey: "  xi-test  ",
    elevenLabsVoiceId: "",
    elevenLabsTtsModel: " custom-tts ",
    elevenLabsSttModel: undefined,
    elevenLabsAutoSpeak: true,
  });
  assert.equal(settings.apiKey, "xi-test");
  assert.equal(settings.voiceId, ELEVENLABS_DEFAULTS.voiceId);
  assert.equal(settings.ttsModel, "custom-tts");
  assert.equal(settings.sttModel, ELEVENLABS_DEFAULTS.sttModel);
  assert.equal(settings.autoSpeak, true);
});

test("speakableText strips markdown noise for voice playback", () => {
  const text = speakableText("## Hello\nUse `search_products` and [this link](https://example.com).\n```ts\nconst x = 1;\n```");
  assert.equal(text, "Hello Use search products and this link.");
});
