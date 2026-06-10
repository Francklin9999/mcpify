import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CaptureBundle, ToolDefinition, ToolFailure } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { DiscoveryDelta } from "./incremental.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";
import { TOOL_SYSTEM_PROMPT, INCREMENTAL_NOTE, HEAL_SYSTEM_PROMPT } from "./llm-prompts.js";

const DEFAULT_MODEL = process.env["GEMINI_MODEL"] || "gemini-3.1-pro-preview";
const LLM_REQUEST_TIMEOUT_MS = Number(process.env["LLM_REQUEST_TIMEOUT_MS"] || 120_000);

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`)), LLM_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Gemini-backed InferenceClient. Uses `responseMimeType: application/json` to force JSON output. */
export class GeminiInferenceClient implements InferenceClient {
  private readonly genAI: GoogleGenerativeAI;

  constructor(apiKey = process.env["GEMINI_API_KEY"] ?? "") {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: process.env["GEMINI_MODEL"] || DEFAULT_MODEL,
      systemInstruction: TOOL_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16000 },
    });
    const result = await withTimeout(
      model.generateContent(
        JSON.stringify({
          url: bundle.url,
          pageAnalysis: analyzeBundleHtml(bundle),
          domSample: bundle.dom.html.slice(0, 8000),
          selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
          network: bundle.network,
        }),
      ),
      "Gemini proposeTools",
    );
    return result.response.text();
  }

  async proposeMoreTools(delta: DiscoveryDelta): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: process.env["GEMINI_MODEL"] || DEFAULT_MODEL,
      systemInstruction: `${TOOL_SYSTEM_PROMPT}\n\n${INCREMENTAL_NOTE}`,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000 },
    });
    const result = await withTimeout(model.generateContent(JSON.stringify(delta)), "Gemini proposeMoreTools");
    return result.response.text();
  }
}

/** Gemini-backed HealClient. */
export class GeminiHealClient implements HealClient {
  private readonly genAI: GoogleGenerativeAI;

  constructor(apiKey = process.env["GEMINI_API_KEY"] ?? "") {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async proposeHeal(failingTool: ToolDefinition, bundle: CaptureBundle, failure: ToolFailure): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: process.env["GEMINI_MODEL"] || DEFAULT_MODEL,
      systemInstruction: HEAL_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000 },
    });
    const result = await withTimeout(
      model.generateContent(
        JSON.stringify({
          brokenTool: failingTool,
          failure,
          snapshot: {
            url: bundle.url,
            dom: bundle.dom.html.slice(0, 20000),
            selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
            network: bundle.network,
          },
        }),
      ),
      "Gemini proposeHeal",
    );
    return result.response.text();
  }
}
