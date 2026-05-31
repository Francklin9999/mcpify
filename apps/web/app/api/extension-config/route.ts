import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension-config
 *
 * Returns ElevenLabs + MongoDB Atlas settings from server env vars so the
 * Chrome extension can self-configure without manual key entry in the options page.
 *
 * The extension calls this on startup and writes any returned values into
 * chrome.storage.local as defaults — values already set via the options page
 * take precedence and are never overwritten.
 *
 * Env vars consumed:
 *   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL, ELEVENLABS_STT_MODEL
 *   MONGODB_ATLAS_ENDPOINT, MONGODB_ATLAS_API_KEY,
 *   MONGODB_ATLAS_DATA_SOURCE, MONGODB_ATLAS_DATABASE, MONGODB_ATLAS_COLLECTION
 */
export async function GET(): Promise<Response> {
  const config: Record<string, unknown> = {};

  // Only include a section if its required credential is present.
  const elKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  if (elKey) {
    config.elevenLabs = {
      apiKey: elKey,
      ...(process.env["ELEVENLABS_VOICE_ID"]?.trim() && { voiceId: process.env["ELEVENLABS_VOICE_ID"]!.trim() }),
      ...(process.env["ELEVENLABS_TTS_MODEL"]?.trim() && { ttsModel: process.env["ELEVENLABS_TTS_MODEL"]!.trim() }),
      ...(process.env["ELEVENLABS_STT_MODEL"]?.trim() && { sttModel: process.env["ELEVENLABS_STT_MODEL"]!.trim() }),
    };
  }

  const atlasEndpoint = process.env["MONGODB_ATLAS_ENDPOINT"]?.trim();
  const atlasApiKey = process.env["MONGODB_ATLAS_API_KEY"]?.trim();
  if (atlasEndpoint && atlasApiKey) {
    config.atlas = {
      endpoint: atlasEndpoint,
      apiKey: atlasApiKey,
      ...(process.env["MONGODB_ATLAS_DATA_SOURCE"]?.trim() && { dataSource: process.env["MONGODB_ATLAS_DATA_SOURCE"]!.trim() }),
      ...(process.env["MONGODB_ATLAS_DATABASE"]?.trim() && { database: process.env["MONGODB_ATLAS_DATABASE"]!.trim() }),
      ...(process.env["MONGODB_ATLAS_COLLECTION"]?.trim() && { collection: process.env["MONGODB_ATLAS_COLLECTION"]!.trim() }),
    };
  }

  return NextResponse.json(config);
}
