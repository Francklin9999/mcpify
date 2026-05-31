import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CaptureBundle, ToolDefinition, ToolFailure } from "@mcp/types";
import type { InferenceClient } from "./inference.js";
import type { DiscoveryDelta } from "./incremental.js";
import type { HealClient } from "./self-heal.js";
import { analyzeBundleHtml } from "./html-analysis.js";
import { TOOL_SYSTEM_PROMPT, INCREMENTAL_NOTE, HEAL_SYSTEM_PROMPT } from "./llm-prompts.js";

const DEFAULT_MODEL = process.env["GEMINI_MODEL"] ?? "gemini-3.1-pro-preview";

/** Gemini-backed InferenceClient. Uses `responseMimeType: application/json` to force JSON output. */
export class GeminiInferenceClient implements InferenceClient {
  private readonly genAI: GoogleGenerativeAI;

  constructor(apiKey = process.env["GEMINI_API_KEY"] ?? "") {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async proposeTools(bundle: CaptureBundle): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: process.env["GEMINI_MODEL"] ?? DEFAULT_MODEL,
      systemInstruction: TOOL_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16000 },
    });
    const result = await model.generateContent(
      JSON.stringify({
        url: bundle.url,
        pageAnalysis: analyzeBundleHtml(bundle),
        domSample: bundle.dom.html.slice(0, 8000),
        selectorsOfInterest: bundle.dom.selectorsOfInterest ?? [],
        network: bundle.network,
      }),
    );
    return result.response.text();
  }

  async proposeMoreTools(delta: DiscoveryDelta): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: process.env["GEMINI_MODEL"] ?? DEFAULT_MODEL,
      systemInstruction: `${TOOL_SYSTEM_PROMPT}\n\n${INCREMENTAL_NOTE}`,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000 },
    });
    const result = await model.generateContent(JSON.stringify(delta));
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
      model: process.env["GEMINI_MODEL"] ?? DEFAULT_MODEL,
      systemInstruction: HEAL_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000 },
    });
    const result = await model.generateContent(
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
    );
    return result.response.text();
  }
}
