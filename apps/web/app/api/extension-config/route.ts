import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension-config
 * Returns ElevenLabs settings from env so the extension can self-configure.
 * MongoDB Atlas is now server-side only (MONGODB_URI) - no credentials needed in the browser.
 */
export async function GET(): Promise<Response> {
  const config: Record<string, unknown> = {};

  const elKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  if (elKey) {
    config.elevenLabs = {
      apiKey: elKey,
      ...(process.env["ELEVENLABS_VOICE_ID"]?.trim() && { voiceId: process.env["ELEVENLABS_VOICE_ID"]!.trim() }),
      ...(process.env["ELEVENLABS_TTS_MODEL"]?.trim() && { ttsModel: process.env["ELEVENLABS_TTS_MODEL"]!.trim() }),
      ...(process.env["ELEVENLABS_STT_MODEL"]?.trim() && { sttModel: process.env["ELEVENLABS_STT_MODEL"]!.trim() }),
    };
  }

  return NextResponse.json(config);
}
