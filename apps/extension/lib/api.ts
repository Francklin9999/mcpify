import type { CaptureBundle, LegalMode, ToolDefinition } from "@mcp/types";
import { DEFAULT_API_BASE } from "./config";

// The extension talks ONLY to the Web API (01 §7) — never to scraper/generator/monitor directly.
export const API_BASE = process.env.PLASMO_PUBLIC_API ?? DEFAULT_API_BASE;

export async function generateFromUrl(
  url: string,
  legalMode: LegalMode = "session",
  bundle?: CaptureBundle,
): Promise<{ jobId?: string; error?: unknown }> {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, legalMode, bundle }),
  });
  return res.json();
}

export async function contribute(serverId: string, bundle: CaptureBundle): Promise<Response> {
  return fetch(`${API_BASE}/api/servers/${serverId}/contribute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
}

type PageContext = { url?: string; title?: string; visibleText?: string };
type AssistMessage = { role: "user" | "assistant"; content: string };

export async function assist(messages: AssistMessage[], pageContext?: PageContext, availableTools?: ToolDefinition[]): Promise<string> {
  const res = await fetch(`${API_BASE}/api/assist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, pageContext, availableTools }),
  });
  return res.text();
}
