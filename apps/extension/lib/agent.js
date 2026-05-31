// lib/agent.js - the side-panel browsing AGENT loop, kept PURE (no chrome/DOM/network here) so it is unit-
// testable offline. The side panel injects three effects: `step` (POST /api/assist with tools → next move),
// `execute` (run a tool against the LIVE tab), and `confirm` (ask the user). This file owns only the control
// flow: when to confirm, how tool results thread back into the conversation, and when to stop.
//
// Tool results are fed back as plain `TOOL_RESULT <name>:` user messages (not OpenAI tool-role threading) -
// simpler and robust across the stateless /api/assist boundary. The model emits structured tool calls; we
// hand back results as text it can read.

/**
 * The actionable live-tab tools the model may call. Mirrors the headless browsing toolkit
 * (services/generator/src/codegen.ts) so the two surfaces behave the same: snapshot assigns a [ref] to each
 * interactive element; click/type/select act by ref; every action returns a fresh snapshot.
 */
export const BROWSER_TOOL_SPECS = [
  {
    name: "browser_snapshot",
    description:
      "List the current tab's interactive elements, each with a [ref] (e.g. e7) for browser_click/browser_type/browser_select_option, plus the page title, URL and a visible-text excerpt. Call this first and again after anything changes the page.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_navigate",
    description:
      "Navigate the current tab to a URL (absolute, or relative to the current page). Off-origin navigations need the user's confirmation. Returns a snapshot of the new page.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Destination URL." } }, required: ["url"] },
  },
  {
    name: "browser_click",
    description: "Click the element with the given [ref] from the latest snapshot (a link, button, result, 'Add to cart', pagination…). Returns a fresh snapshot.",
    parameters: { type: "object", properties: { ref: { type: "string", description: "Element ref from a snapshot, e.g. e7." } }, required: ["ref"] },
  },
  {
    name: "browser_type",
    description: "Type text into the input/textarea with the given [ref]. Set submit=true to press Enter (e.g. to run a search). Returns a fresh snapshot.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from a snapshot." },
        text: { type: "string", description: "Text to type." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_select_option",
    description: "Choose an option (by value or visible label) in the <select> with the given [ref]. Returns a fresh snapshot.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from a snapshot." },
        value: { type: "string", description: "Option value or label." },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "browser_press_key",
    description:
      "Press a key (Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace). Useful to confirm a typed value, drive a calendar/dropdown, or dismiss a popup (Escape). Optionally target a [ref]; otherwise the focused element. Returns a fresh snapshot.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. Enter, Escape, ArrowDown." },
        ref: { type: "string", description: "Optional element ref to focus first." },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page in the current tab. Returns a fresh snapshot.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_read_page",
    description: "Return the readable text content of the current page (no markup).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_extract",
    description: "Extract structured JSON from the current page. mode = 'product', 'listing', or 'metadata' (default).",
    parameters: { type: "object", properties: { mode: { type: "string", description: "product | listing | metadata" } } },
  },
];

/** Tools that change page/account state - always confirmed with the user before running. */
export const MUTATING_TOOLS = new Set(["browser_click", "browser_type", "browser_select_option"]);

const MAX_RESULT_CHARS = 8000;

function truncate(value, max = MAX_RESULT_CHARS) {
  const text = String(value == null ? "" : value);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function recoveryHintFor(call, result) {
  const text = String(result == null ? "" : result);
  if (!text) return "";
  if (/No element for ref|stale ref/i.test(text)) {
    return "The page changed and the old ref is stale. Call browser_snapshot now, read the fresh refs, then retry with one of them. Do not ask the user to click manually.";
  }
  if (/No element for selector|Couldn't find .* on the current page/i.test(text)) {
    return "The page layout changed or the selector missed. Call browser_snapshot to inspect the live page again, then use visible refs or another tool. Do not ask the user to do it themselves.";
  }
  if (/current tab isn't a web page|No active tab/i.test(text)) {
    return "Recover by navigating to the visible site tab first, then call browser_snapshot and continue.";
  }
  if (/Request failed for|failed to fetch|networkerror|ERR_/i.test(text)) {
    return "Try a visible-tab browser tool path instead of background HTTP if the page has controls for this action.";
  }
  if (/User declined/i.test(text)) {
    return "Do not retry the same mutating step. Prefer a read-only alternative, or ask for permission only if there is no non-mutating path.";
  }
  return "";
}

function toolResultMessage(call, result) {
  const hint = recoveryHintFor(call, result);
  const body = truncate(result);
  return { role: "user", content: `TOOL_RESULT ${call.name}:\n${body}${hint ? `\n\nRECOVERY_HINT: ${hint}` : ""}` };
}

/** True if `targetUrl` (possibly relative) resolves to the same origin as `currentUrl`. Unknown ⇒ false. */
export function sameOrigin(targetUrl, currentUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(String(targetUrl), currentUrl);
    return target.origin === current.origin;
  } catch {
    return false;
  }
}

/**
 * Whether a tool call must be confirmed by the user before it runs:
 *   - any mutating action (click / type / select), and
 *   - any OFF-ORIGIN navigation (a bare GET to another origin is consequential on a logged-in session -
 *     e.g. /logout, /cart/add - so it isn't auto-run). Same-origin navigation and reads run freely.
 */
export function needsConfirm(call, currentUrl) {
  if (MUTATING_TOOLS.has(call.name)) return true;
  if (call.name === "browser_navigate") {
    const url = String(call?.arguments?.url ?? "");
    if (!url) return false;
    return !sameOrigin(url, currentUrl);
  }
  return false;
}

/**
 * Keep only the LATEST tool result full; collapse every earlier `TOOL_RESULT …` message to its first line.
 * Older snapshots are stale (the page has moved on) and re-sending all of them grows the prompt ~quadratically
 * over a multi-step turn - the main cause of the loop getting slow AND confused about what's on screen now.
 * Returns a pruned COPY; the real transcript keeps full history.
 */
export function pruneForModel(messages) {
  let lastToolResult = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string" && m.content.startsWith("TOOL_RESULT ")) {
      lastToolResult = i;
      break;
    }
  }
  if (lastToolResult <= 0) return messages;
  return messages.map((m, i) => {
    if (i !== lastToolResult && m && m.role === "user" && typeof m.content === "string" && m.content.startsWith("TOOL_RESULT ")) {
      const firstLine = m.content.split("\n", 1)[0];
      return { role: "user", content: `${firstLine} (earlier output omitted)` };
    }
    return m;
  });
}

/** Coerce an /api/assist JSON body into a clean { text?, toolCalls } StepResponse. Never throws. */
export function parseStepResponse(data) {
  const text = data && typeof data.text === "string" && data.text.trim() ? data.text.trim() : undefined;
  const toolCalls = [];
  const raw = data && Array.isArray(data.toolCalls) ? data.toolCalls : [];
  for (const call of raw) {
    if (!call || typeof call.name !== "string") continue;
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
    toolCalls.push({ id: typeof call.id === "string" ? call.id : undefined, name: call.name, arguments: args });
  }
  return { text, toolCalls };
}

// Discovered (generated-server) tools usable live in-session
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Turn generated-server ToolDefinitions into model function-specs the agent can call alongside the primitives. */
export function discoveredToolSpecs(toolDefs) {
  return (toolDefs || [])
    .filter((t) => t && typeof t.name === "string" && t.inputSchema)
    .map((t) => ({
      name: t.name,
      description:
        t.execution?.kind === "http"
          ? `${t.description || t.name} In this side panel, same-tab GET tools visibly navigate the current tab; mutating HTTP tools act on the user's live session after confirmation.`
          : `${t.description || t.name} In this side panel, browser-step tools run on the user's current visible tab, not a headless browser.`,
      parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: "object", properties: {} },
    }));
}

/** A discovered HTTP tool that changes state (POST/PUT/PATCH/DELETE) - confirmed before running, like clicks. */
export function isMutatingHttpTool(toolDef) {
  return (
    toolDef &&
    toolDef.execution &&
    toolDef.execution.kind === "http" &&
    MUTATING_METHODS.has(String(toolDef.execution.request?.method || "GET").toUpperCase())
  );
}

function browserStepMutates(step) {
  return step && ["click", "fill", "selectOption", "pressKey"].includes(step.action);
}

function browserStepNavigatesOffOrigin(step, currentUrl, args) {
  if (!step || step.action !== "navigate" || !step.value) return false;
  const target = String(step.value).replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const value = args && Object.prototype.hasOwnProperty.call(args, key) ? args[key] : "";
    return value == null ? "" : String(value);
  });
  return target ? !sameOrigin(target, currentUrl) : false;
}

/** Discovered tools can wrap browser steps; confirm mutating/off-origin ones before executing them live. */
export function needsConfirmDiscoveredTool(toolDef, currentUrl, args = {}) {
  if (!toolDef || !toolDef.execution) return false;
  if (toolDef.execution.kind === "http") return isMutatingHttpTool(toolDef);
  if (toolDef.execution.kind !== "browser") return false;
  return toolDef.execution.steps.some((step) => browserStepMutates(step) || browserStepNavigatesOffOrigin(step, currentUrl, args));
}

/**
 * Build a fetch {url, init} for a discovered HTTP tool from its execution + args - mirrors the generated
 * server's callHttp param mapping. Runs with `credentials: "include"` so it acts as the user's live session.
 */
export function httpRequestFromTool(execution, args) {
  const req = execution.request;
  const mapping = execution.paramMapping || {};
  let url;
  try {
    url = new URL(req.rawUrl).origin + req.urlPattern;
  } catch {
    url = req.urlPattern;
  }
  const query = new URLSearchParams();
  const headers = { ...(req.requestHeaders || {}) };
  const body = {};
  let hasBody = false;
  for (const [param, value] of Object.entries(args || {})) {
    const m = mapping[param];
    if (!m) continue;
    if (m.in === "path") url = url.replace("{" + m.key + "}", encodeURIComponent(String(value)));
    else if (m.in === "query") query.set(m.key, String(value));
    else if (m.in === "header") headers[m.key] = String(value);
    else {
      body[m.key] = value;
      hasBody = true;
    }
  }
  const qs = query.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  const init = { method: req.method || "GET", headers, credentials: "include" };
  if (hasBody) {
    headers["content-type"] = headers["content-type"] || "application/json";
    init.body = JSON.stringify(body);
  }
  return { url, init };
}

/**
 * Run the agent loop to completion. `initial` is the conversation so far ({role,content}[]). `deps`:
 *   step(messages)        -> Promise<{ text?, toolCalls? }>   (one model move; usually POST /api/assist)
 *   execute(call)         -> Promise<string>                  (run the tool against the live tab)
 *   confirm(call)         -> Promise<boolean>                 (ask the user; mutating/off-origin only)
 *   currentUrl()          -> string | Promise<string>         (the tab's URL, for off-origin gating)
 *   onText?(text)         -> void                             (render assistant prose as it arrives)
 *   onToolStart?(call)    -> void
 *   onToolResult?(call, result, skipped) -> void
 *   signal?               -> { aborted: boolean }             (Stop button; checked between awaits)
 *   maxSteps?             -> number (default 8)
 * Resolves with { messages, finalText, stoppedReason: 'done'|'max_steps'|'aborted' }.
 */
export async function runAgent(initial, deps) {
  const messages = Array.isArray(initial) ? initial.slice() : [];
  const maxSteps = deps.maxSteps ?? 8;
  // Default gate is the built-in (mutating primitives + off-origin nav); the side panel overrides it to ALSO
  // confirm mutating discovered HTTP tools (add_to_cart etc.).
  const gate = deps.needsConfirm || needsConfirm;
  const aborted = () => Boolean(deps.signal && deps.signal.aborted);
  let finalText = "";
  let lastSignature = "";
  let repeats = 0;
  let recoveryNudges = 0;
  const declinedSignatures = new Set();

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    if (aborted()) return { messages, finalText, stoppedReason: "aborted" };

    // Send a pruned view (latest snapshot full, older ones collapsed) - smaller, faster, less stale-state confusion.
    const res = (await deps.step(pruneForModel(messages))) || {};
    if (res.text && String(res.text).trim()) {
      finalText = String(res.text).trim();
      deps.onText && deps.onText(finalText);
      messages.push({ role: "assistant", content: finalText });
    }

    const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
    if (!calls.length) return { messages, finalText, stoppedReason: "done" };

    // Loop guard: the same batch of calls twice in a row means the model is stuck (the plain-text feedback
    // makes an occasional repeat more likely) - stop and hand back to the user instead of spinning.
    const signature = JSON.stringify(calls.map((call) => [call.name, call.arguments]));
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 2) {
      if (recoveryNudges < 1) {
        recoveryNudges++;
        messages.push({
          role: "user",
          content:
            "SYSTEM_HINT: You repeated the same action without progress. Do not ask the user to do it manually. Refresh the page state with browser_snapshot, then choose a different next step.",
        });
        lastSignature = "";
        repeats = 0;
        continue;
      }
      const note = "Stopping - I repeated the same action without progress. Tell me how you'd like to proceed.";
      deps.onText && deps.onText(note);
      return { messages, finalText: finalText || note, stoppedReason: "done" };
    }

    const url = String(await deps.currentUrl());
    for (const call of calls) {
      if (aborted()) return { messages, finalText, stoppedReason: "aborted" };
      deps.onToolStart && deps.onToolStart(call);

      let result;
      let skipped = false;
      if (gate(call, url)) {
        const confirmSignature = JSON.stringify([call.name, call.arguments]);
        if (declinedSignatures.has(confirmSignature)) {
          skipped = true;
          result = `User already declined to run ${call.name} with these arguments in this turn. Do not ask again; choose a different, preferably read-only or generated-tool approach.`;
        } else {
          const ok = await deps.confirm(call);
          if (aborted()) return { messages, finalText, stoppedReason: "aborted" };
          if (!ok) {
            skipped = true;
            declinedSignatures.add(confirmSignature);
            result = `User declined to run ${call.name}. Do not retry the same action; choose a different, preferably read-only or generated-tool approach.`;
          } else {
            result = await deps.execute(call);
          }
        }
      } else {
        result = await deps.execute(call);
      }

      deps.onToolResult && deps.onToolResult(call, result, skipped);
      messages.push(toolResultMessage(call, result));
    }
  }

  const note = "I reached the step limit before finishing. Tell me to continue if you'd like me to keep going.";
  deps.onText && deps.onText(note);
  return { messages, finalText: finalText || note, stoppedReason: "max_steps" };
}
