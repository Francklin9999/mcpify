import OpenAI from "openai";
import { NextResponse } from "next/server";
import { AssistRequest, type AssistStepResponse, type AssistToolCall } from "@mcp/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

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

function assistantPrompt(req: AssistRequest): string {
  const parts = [
    "You are the MCP Forge side-panel assistant. Help the user understand the current browser page and decide which page actions should become MCP tools.",
    "Be concise, concrete, and honest about uncertainty. If generated MCP server details are in the conversation, use them. Do not invent page facts beyond the supplied context.",
  ];

  if (req.pageContext) {
    const context = [
      req.pageContext.title ? `Title: ${req.pageContext.title}` : "",
      req.pageContext.url ? `URL: ${req.pageContext.url}` : "",
      req.pageContext.visibleText ? `Live page context:\n${req.pageContext.visibleText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (context) parts.push(`Current page context:\n${context}`);
  }

  if (req.availableTools?.length) {
    parts.push(
      `Available generated tools:\n${req.availableTools
        .map((tool) => `- ${tool.name}: ${tool.description} (${tool.execution.kind}, confidence ${tool.confidence})`)
        .join("\n")}`,
    );
  }

  return parts.join("\n\n");
}

function fallbackText(req: AssistRequest): string {
  const last = req.messages.at(-1)?.content.trim() ?? "";
  const toolCount = req.availableTools?.length ?? 0;
  const context = req.pageContext?.url ? ` for ${req.pageContext.url}` : req.pageContext?.title ? ` for ${req.pageContext.title}` : "";
  const visibleText = req.pageContext?.visibleText ? " I also received live page context from the extension." : "";
  return `I can inspect ${toolCount} available tools${context}.${visibleText} Current request: ${last}`;
}

// ── Agent (tool-calling) mode ───────────────────────────────────────────────────────────────────────
// When the side panel passes actionable live-tab `tools`, /api/assist runs ONE function-calling step and
// returns JSON (an AssistStepResponse). The extension owns the loop: it executes the returned toolCalls
// against the user's CURRENT tab (asking the user to confirm mutating / off-origin actions), appends each
// outcome as a `TOOL_RESULT <name>:` user message, and calls back for the next step.
function agentSystemPrompt(req: AssistRequest): string {
  const parts = [
    "You are the MCP Forge side-panel agent. You DRIVE THE USER'S CURRENT, VISIBLE BROWSER TAB — the exact page they are looking at — and they WATCH every step happen. This is NOT a separate or headless browser.",
    "Strongly PREFER acting on the page that's already on screen: use browser_snapshot to see it, then browser_click / browser_type / browser_select_option on its real controls (its search box, its buttons, its results), and browser_navigate to move within the same tab. Do this instead of any invisible/background request when the page itself offers the control. The user should always see the page change.",
    "Protocol: call browser_snapshot FIRST to see the page's interactive elements. Each has a [ref] (like e7) you pass to browser_click / browser_type / browser_select_option. After every tool call you receive a `TOOL_RESULT <tool>:` message with a fresh snapshot or result; use it to decide the next step. Refs change when the page changes, so the latest snapshot is the source of truth.",
    "Never tell the user to click, type, navigate, search, open a result, add to cart, or otherwise do browser work themselves when an available tool can do it. If a tool fails or a ref/selector goes stale, recover yourself: call browser_snapshot, read the fresh page state, and try a different valid step.",
    "Widgets (date pickers, calendars, dropdowns, autocomplete): these are usually CLOSED until you interact. To pick a date or option: (1) browser_click the field to OPEN it, (2) browser_snapshot to see the calendar days / options that appeared, (3) browser_click the specific day or option by its ref. If the days/options still aren't in the snapshot, try browser_type to enter the value (e.g. a date like 2026-06-15) then browser_press_key Enter, or use browser_press_key with ArrowDown/Enter/Escape to drive or dismiss the widget. Don't give up after one click — open, look, then pick.",
    "Mutating actions (click/type/select) and off-origin navigations require the user's confirmation and MAY be declined (you'll see 'User declined…'); if declined, adapt or ask the user, don't retry blindly.",
    "Take ONE sensible step at a time. When the task is done or you need the user, stop calling tools and reply in plain text. Be concise and never invent page facts you didn't read.",
  ];
  if (req.pageContext) {
    const ctx = [
      req.pageContext.title ? `Title: ${req.pageContext.title}` : "",
      req.pageContext.url ? `URL: ${req.pageContext.url}` : "",
      req.pageContext.visibleText ? `Initial page context:\n${req.pageContext.visibleText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (ctx) parts.push(`Current tab:\n${ctx}`);
  }
  return parts.join("\n\n");
}

function parseToolCalls(message: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }): AssistToolCall[] {
  const calls: AssistToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function?.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      /* model emitted invalid JSON args — treat as empty */
    }
    calls.push({ id: call.id, name, arguments: args });
  }
  return calls;
}

async function agentStep(req: AssistRequest, apiKey: string): Promise<Response> {
  const client = new OpenAI({ apiKey });
  try {
    const completion = await client.chat.completions.create({
      // gpt-5.4 reasons about the page, which handles tricky widgets (calendars, dropdowns) much better than
      // gpt-4o. Override with AGENT_MODEL=gpt-5.4-mini for lower latency, or AGENT_REASONING=low|medium|high
      // for more deliberate steps. NOTE: gpt-5.x needs max_completion_tokens (it rejects max_tokens).
      model: process.env.AGENT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4",
      max_completion_tokens: 2000,
      ...(process.env.AGENT_REASONING ? { reasoning_effort: process.env.AGENT_REASONING as "low" | "medium" | "high" } : {}),
      tools: (req.tools ?? []).map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
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
      toolCalls: parseToolCalls(message),
    };
    return NextResponse.json(step);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// Tool mode with no key configured: end the loop gracefully with a plain-text step (no tool calls).
function agentFallbackStep(req: AssistRequest): Response {
  const last = req.messages.filter((m) => m.role === "user").at(-1)?.content.trim() ?? "";
  return NextResponse.json({
    text:
      "I can't drive the page right now — set OPENAI_API_KEY on the web app to enable the browsing agent. " +
      (last ? `Your request was: "${last.slice(0, 200)}".` : ""),
    toolCalls: [],
  } satisfies AssistStepResponse);
}

// POST /api/assist — streams an assistant turn, OR (when `tools` are present) returns one JSON agent step.
export async function POST(req: Request): Promise<Response> {
  const parsed = AssistRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const apiKey = process.env.OPENAI_API_KEY;

  // Agent/tool mode (additive): present iff the side panel passes actionable tools.
  if (parsed.data.tools?.length) {
    return apiKey ? agentStep(parsed.data, apiKey) : agentFallbackStep(parsed.data);
  }

  if (!apiKey) return textStream(fallbackText(parsed.data));

  const client = new OpenAI({ apiKey });

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const stream = await client.chat.completions.create({
            model: process.env.OPENAI_MODEL ?? "gpt-5.4",
            max_completion_tokens: 1200,
            stream: true,
            messages: [
              {
                role: "system",
                content: assistantPrompt(parsed.data),
              },
              ...parsed.data.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
            ],
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
