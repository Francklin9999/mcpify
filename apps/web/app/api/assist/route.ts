import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { AssistRequest, type AssistStepResponse, type AssistToolCall } from "@mcp/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

// ── Provider selection ────────────────────────────────────────────────────────

type Provider = "openai" | "claude" | "gemini";

function activeProvider(): Provider {
  const p = (process.env["LLM_PROVIDER"] ?? "openai").toLowerCase();
  if (p === "claude") return "claude";
  if (p === "gemini") return "gemini";
  return "openai";
}

function activeApiKey(): string | undefined {
  const p = activeProvider();
  if (p === "claude") return process.env["ANTHROPIC_API_KEY"];
  if (p === "gemini") return process.env["GEMINI_API_KEY"];
  return process.env["OPENAI_API_KEY"];
}

function activeModel(forAgent = false): string {
  const override = forAgent ? process.env["AGENT_MODEL"] : undefined;
  const p = activeProvider();
  if (p === "claude") return override ?? process.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6";
  if (p === "gemini") return override ?? process.env["GEMINI_MODEL"] ?? "gemini-2.0-flash";
  return override ?? process.env["OPENAI_MODEL"] ?? "gpt-5.4";
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function textStream(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

function assistantSystemPrompt(req: AssistRequest): string {
  const parts = [
    "You are the MCP Forge side-panel assistant. Help the user understand the current browser page and decide which page actions should become MCP tools.",
    "Be concise, concrete, and honest about uncertainty. If generated MCP server details are in the conversation, use them. Do not invent page facts beyond the supplied context.",
  ];
  if (req.pageContext) {
    const ctx = [
      req.pageContext.title ? `Title: ${req.pageContext.title}` : "",
      req.pageContext.url ? `URL: ${req.pageContext.url}` : "",
      req.pageContext.visibleText ? `Live page context:\n${req.pageContext.visibleText}` : "",
    ].filter(Boolean).join("\n");
    if (ctx) parts.push(`Current page context:\n${ctx}`);
  }
  if (req.availableTools?.length) {
    parts.push(
      `Available generated tools:\n${req.availableTools
        .map((t) => `- ${t.name}: ${t.description} (${t.execution.kind}, confidence ${t.confidence})`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

function agentSystemPrompt(req: AssistRequest): string {
  const parts = [
    "You are the MCP Forge side-panel agent. You DRIVE THE USER'S CURRENT, VISIBLE BROWSER TAB — the exact page they are looking at — and they WATCH every step happen. This is NOT a separate or headless browser.",
    "Strongly PREFER acting on the page that's already on screen: use browser_snapshot to see it, then browser_click / browser_type / browser_select_option on its real controls, and browser_navigate to move within the same tab.",
    "Protocol: call browser_snapshot FIRST. Each interactive element has a [ref] (like e7) you pass to browser_click / browser_type / browser_select_option. After every tool call you receive a TOOL_RESULT message with a fresh snapshot; use it for the next step.",
    "Never tell the user to click or type themselves when an available tool can do it. If a step fails, recover: call browser_snapshot and try again.",
    "Mutating actions and off-origin navigations require user confirmation and MAY be declined. If declined, adapt.",
    "Take ONE sensible step at a time. When done, stop calling tools and reply in plain text.",
  ];
  if (req.pageContext) {
    const ctx = [
      req.pageContext.title ? `Title: ${req.pageContext.title}` : "",
      req.pageContext.url ? `URL: ${req.pageContext.url}` : "",
      req.pageContext.visibleText ? `Initial page context:\n${req.pageContext.visibleText}` : "",
    ].filter(Boolean).join("\n");
    if (ctx) parts.push(`Current tab:\n${ctx}`);
  }
  return parts.join("\n\n");
}

function fallbackText(req: AssistRequest): string {
  const last = req.messages.at(-1)?.content.trim() ?? "";
  const toolCount = req.availableTools?.length ?? 0;
  const context = req.pageContext?.url
    ? ` for ${req.pageContext.url}`
    : req.pageContext?.title ? ` for ${req.pageContext.title}` : "";
  return `I can inspect ${toolCount} available tools${context}. Set LLM_PROVIDER + the matching API key to enable the AI assistant. Current request: ${last}`;
}

// ── OpenAI implementations ────────────────────────────────────────────────────

async function streamOpenAI(req: AssistRequest, apiKey: string): Promise<Response> {
  const client = new OpenAI({ apiKey });
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const stream = await client.chat.completions.create({
            model: activeModel(),
            max_completion_tokens: 1200,
            stream: true,
            messages: [
              { role: "system", content: assistantSystemPrompt(req) },
              ...req.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
        } catch (err) { controller.error(err); return; }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

function parseOpenAIToolCalls(message: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }): AssistToolCall[] {
  return (message.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name) return [];
    let args: Record<string, unknown> = {};
    try {
      const p = JSON.parse(call.function?.arguments || "{}");
      if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
    } catch { /* ignore */ }
    return [{ id: call.id, name, arguments: args }];
  });
}

async function agentStepOpenAI(req: AssistRequest, apiKey: string): Promise<Response> {
  const client = new OpenAI({ apiKey });
  try {
    const completion = await client.chat.completions.create({
      model: activeModel(true),
      max_completion_tokens: 2000,
      ...(process.env["AGENT_REASONING"] ? { reasoning_effort: process.env["AGENT_REASONING"] as "low" | "medium" | "high" } : {}),
      tools: (req.tools ?? []).map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
      })),
      tool_choice: "auto",
      messages: [
        { role: "system", content: agentSystemPrompt(req) },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    const message = completion.choices[0]?.message ?? {};
    const step: AssistStepResponse = {
      text: typeof message.content === "string" && message.content.trim() ? message.content : undefined,
      toolCalls: parseOpenAIToolCalls(message),
    };
    return NextResponse.json(step);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// ── Claude implementations ────────────────────────────────────────────────────

async function streamClaude(req: AssistRequest, apiKey: string): Promise<Response> {
  const client = new Anthropic({ apiKey });
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const stream = await client.messages.create({
            model: activeModel(),
            max_tokens: 1200,
            stream: true,
            system: assistantSystemPrompt(req),
            messages: req.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
        } catch (err) { controller.error(err); return; }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

async function agentStepClaude(req: AssistRequest, apiKey: string): Promise<Response> {
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: activeModel(true),
      max_tokens: 2000,
      system: agentSystemPrompt(req),
      tools: (req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: (t.parameters ?? { type: "object", properties: {} }) as Anthropic.Messages.Tool["input_schema"],
      })),
      messages: req.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text).join("") || undefined;
    const toolCalls: AssistToolCall[] = response.content
      .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));
    return NextResponse.json({ text: text?.trim() || undefined, toolCalls } satisfies AssistStepResponse);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// ── Gemini implementations ────────────────────────────────────────────────────

async function streamGemini(req: AssistRequest, apiKey: string): Promise<Response> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: activeModel(),
    systemInstruction: assistantSystemPrompt(req),
  });
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const result = await model.generateContentStream({
            contents: req.messages
              .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          });
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) controller.enqueue(encoder.encode(text));
          }
        } catch (err) { controller.error(err); return; }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

async function agentStepGemini(req: AssistRequest, apiKey: string): Promise<Response> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: activeModel(true),
    systemInstruction: agentSystemPrompt(req),
    tools: [
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        functionDeclarations: (req.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as any,
        })),
      },
    ],
  });
  try {
    const result = await model.generateContent({
      contents: req.messages
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    });
    const response = result.response;
    const text = response.text().trim() || undefined;
    const calls = response.functionCalls() ?? [];
    const toolCalls: AssistToolCall[] = calls.map((c) => ({
      name: c.name,
      arguments: (c.args ?? {}) as Record<string, unknown>,
    }));
    return NextResponse.json({ text: text || undefined, toolCalls } satisfies AssistStepResponse);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

function agentFallback(req: AssistRequest): Response {
  const last = req.messages.filter((m) => m.role === "user").at(-1)?.content.trim() ?? "";
  return NextResponse.json({
    text:
      `I can't drive the page right now — set LLM_PROVIDER + the matching API key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) to enable the browsing agent. ` +
      (last ? `Your request was: "${last.slice(0, 200)}".` : ""),
    toolCalls: [],
  } satisfies AssistStepResponse);
}

export async function POST(req: Request): Promise<Response> {
  const parsed = AssistRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const apiKey = activeApiKey();
  const provider = activeProvider();

  // Agent/tool-calling mode
  if (parsed.data.tools?.length) {
    if (!apiKey) return agentFallback(parsed.data);
    if (provider === "claude") return agentStepClaude(parsed.data, apiKey);
    if (provider === "gemini") return agentStepGemini(parsed.data, apiKey);
    return agentStepOpenAI(parsed.data, apiKey);
  }

  // Streaming chat mode
  if (!apiKey) return textStream(fallbackText(parsed.data));
  if (provider === "claude") return streamClaude(parsed.data, apiKey);
  if (provider === "gemini") return streamGemini(parsed.data, apiKey);
  return streamOpenAI(parsed.data, apiKey);
}
