import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAgent,
  needsConfirm,
  sameOrigin,
  parseStepResponse,
  pruneForModel,
  MUTATING_TOOLS,
  BROWSER_TOOL_SPECS,
  discoveredToolSpecs,
  isMutatingHttpTool,
  needsConfirmDiscoveredTool,
  httpRequestFromTool,
} from "../lib/agent.js";

// A scripted model: returns the next queued step each time it's called, recording the messages it saw.
function scriptedStep(steps: any[]) {
  const seen: any[][] = [];
  let i = 0;
  const fn = async (messages: any[]) => {
    seen.push(messages.map((m) => ({ ...m })));
    return steps[Math.min(i++, steps.length - 1)];
  };
  return Object.assign(fn, { seen }); // call count == seen.length
}

const ORIGIN = "https://shop.example.com/cart";

test("needsConfirm gates mutating actions and off-origin navigation only", () => {
  assert.equal(needsConfirm({ name: "browser_click", arguments: { ref: "e1" } }, ORIGIN), true);
  assert.equal(needsConfirm({ name: "browser_type", arguments: { ref: "e1", text: "x" } }, ORIGIN), true);
  assert.equal(needsConfirm({ name: "browser_select_option", arguments: { ref: "e1", value: "v" } }, ORIGIN), true);
  // reads never confirm
  assert.equal(needsConfirm({ name: "browser_snapshot", arguments: {} }, ORIGIN), false);
  assert.equal(needsConfirm({ name: "browser_read_page", arguments: {} }, ORIGIN), false);
  // same-origin navigation runs freely; off-origin (and relative-resolving-off-origin is impossible) confirms
  assert.equal(needsConfirm({ name: "browser_navigate", arguments: { url: "https://shop.example.com/checkout" } }, ORIGIN), false);
  assert.equal(needsConfirm({ name: "browser_navigate", arguments: { url: "/account" } }, ORIGIN), false);
  assert.equal(needsConfirm({ name: "browser_navigate", arguments: { url: "https://evil.example.net/" } }, ORIGIN), true);
});

test("sameOrigin resolves relative URLs and fails closed on garbage", () => {
  assert.equal(sameOrigin("/x", "https://a.com/y"), true);
  assert.equal(sameOrigin("https://a.com/x", "https://a.com/y"), true);
  assert.equal(sameOrigin("https://b.com/x", "https://a.com/y"), false);
  assert.equal(sameOrigin("not a url", "also not a url"), false);
});

test("the tool specs match the headless toolkit and mutating set", () => {
  const names = BROWSER_TOOL_SPECS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "browser_back",
    "browser_click",
    "browser_extract",
    "browser_navigate",
    "browser_press_key",
    "browser_read_page",
    "browser_select_option",
    "browser_snapshot",
    "browser_type",
  ]);
  for (const m of MUTATING_TOOLS) assert.ok(names.includes(m));
});

test("needsConfirmDiscoveredTool gates browser-step tools that mutate or leave origin", () => {
  assert.equal(
    needsConfirmDiscoveredTool(
      { execution: { kind: "browser", steps: [{ action: "click", target: { role: "button", selector: "button.add" } }] } },
      ORIGIN,
      {},
    ),
    true,
  );
  assert.equal(
    needsConfirmDiscoveredTool(
      { execution: { kind: "browser", steps: [{ action: "navigate", value: "/search?q={{query}}" }] } },
      ORIGIN,
      { query: "shoe" },
    ),
    false,
  );
  assert.equal(
    needsConfirmDiscoveredTool(
      { execution: { kind: "browser", steps: [{ action: "navigate", value: "https://evil.example.net/cart" }] } },
      ORIGIN,
      {},
    ),
    true,
  );
});

test("multi-step: a tool call result threads back as TOOL_RESULT, then the model finishes", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_snapshot", arguments: {} }] },
    { text: "The page has a search box and 3 results." },
  ]);
  const executed: any[] = [];
  const out = await runAgent([{ role: "user", content: "what's on the page?" }], {
    step,
    execute: async (call) => {
      executed.push(call);
      return "PAGE: Shop\n[e1] textbox \"Search\"\n[e2] link \"Result\"";
    },
    confirm: async () => true,
    currentUrl: () => ORIGIN,
  });

  assert.equal(out.stoppedReason, "done");
  assert.equal(out.finalText, "The page has a search box and 3 results.");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "browser_snapshot");
  // the second step saw the TOOL_RESULT fed back as a user message
  const secondCallMessages = step.seen[1];
  const toolResult = secondCallMessages.at(-1);
  assert.equal(toolResult.role, "user");
  assert.match(toolResult.content, /^TOOL_RESULT browser_snapshot:/);
  assert.match(toolResult.content, /Search/);
});

test("declined mutating action: execute is NOT called and the loop CONTINUES informed", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_click", arguments: { ref: "e9" } }] },
    { text: "Okay, I won't add it to the cart." },
  ]);
  let executeCalls = 0;
  let confirmAsked: any = null;
  const out = await runAgent([{ role: "user", content: "add to cart" }], {
    step,
    execute: async () => {
      executeCalls++;
      return "clicked";
    },
    confirm: async (call) => {
      confirmAsked = call;
      return false; // user declines
    },
    currentUrl: () => ORIGIN,
  });

  assert.equal(confirmAsked?.name, "browser_click");
  assert.equal(executeCalls, 0, "declined action must not execute");
  assert.equal(out.stoppedReason, "done");
  assert.equal(out.finalText, "Okay, I won't add it to the cart.");
  // the decline was fed back so the model could adapt
  const declineMsg = step.seen[1].at(-1);
  assert.match(declineMsg.content, /TOOL_RESULT browser_click/);
  assert.match(declineMsg.content, /declined/i);
  assert.match(declineMsg.content, /RECOVERY_HINT/);
});

test("confirmed mutating action executes", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_click", arguments: { ref: "e9" } }] },
    { text: "Added to cart." },
  ]);
  let executed = 0;
  await runAgent([{ role: "user", content: "add the first one" }], {
    step,
    execute: async () => {
      executed++;
      return "PAGE: Cart (1 item)";
    },
    confirm: async () => true,
    currentUrl: () => ORIGIN,
  });
  assert.equal(executed, 1);
});

test("a step may emit BOTH assistant text and tool calls", async () => {
  const texts: string[] = [];
  const step = scriptedStep([
    { text: "Let me look at the page.", toolCalls: [{ name: "browser_snapshot", arguments: {} }] },
    { text: "Done." },
  ]);
  const out = await runAgent([{ role: "user", content: "hi" }], {
    step,
    execute: async () => "snapshot",
    confirm: async () => true,
    currentUrl: () => ORIGIN,
    onText: (t) => texts.push(t),
  });
  assert.deepEqual(texts, ["Let me look at the page.", "Done."]);
  assert.equal(out.finalText, "Done.");
});

test("plain chat (no tool calls) ends immediately", async () => {
  const step = scriptedStep([{ text: "Hello! How can I help with this page?" }]);
  const out = await runAgent([{ role: "user", content: "hi" }], {
    step,
    execute: async () => assert.fail("execute should not be called"),
    confirm: async () => assert.fail("confirm should not be called"),
    currentUrl: () => ORIGIN,
  });
  assert.equal(out.stoppedReason, "done");
  assert.equal(step.seen.length, 1);
});

test("maxSteps caps a runaway loop and surfaces it", async () => {
  // model always asks for another snapshot (with varying args so the repeat-guard doesn't fire first)
  let n = 0;
  const step = async () => ({ toolCalls: [{ name: "browser_snapshot", arguments: { n: n++ } }] });
  const out = await runAgent([{ role: "user", content: "go" }], {
    step,
    execute: async () => "snap",
    confirm: async () => true,
    currentUrl: () => ORIGIN,
    maxSteps: 3,
  });
  assert.equal(out.stoppedReason, "max_steps");
  assert.match(out.finalText, /step limit/i);
});

test("repeat guard stops identical back-to-back tool batches", async () => {
  const step = async () => ({ toolCalls: [{ name: "browser_click", arguments: { ref: "e1" } }] });
  let executed = 0;
  const out = await runAgent([{ role: "user", content: "go" }], {
    step,
    execute: async () => {
      executed++;
      return "clicked";
    },
    confirm: async () => true,
    currentUrl: () => ORIGIN,
    maxSteps: 20,
  });
  assert.equal(out.stoppedReason, "done");
  // stopped well before maxSteps: the loop now grants one recovery nudge before finally stopping.
  assert.ok(executed <= 4, `expected the repeat guard to stop early, executed=${executed}`);
});

test("tool failures include a recovery hint so the model retries itself first", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_click", arguments: { ref: "e1" } }] },
    { text: "I refreshed the page state and will try again." },
  ]);
  const out = await runAgent([{ role: "user", content: "open the first result" }], {
    step,
    execute: async () => "No element for ref e1. Call browser_snapshot for current refs.",
    confirm: async () => true,
    currentUrl: () => ORIGIN,
  });
  assert.equal(out.stoppedReason, "done");
  const failureMsg = step.seen[1].at(-1);
  assert.match(failureMsg.content, /TOOL_RESULT browser_click/);
  assert.match(failureMsg.content, /RECOVERY_HINT/);
  assert.match(failureMsg.content, /browser_snapshot/);
});

test("repeat guard injects a recovery hint before giving up", async () => {
  let calls = 0;
  const step = async (messages: any[]) => {
    const sawHint = messages.some((m) => typeof m.content === "string" && m.content.includes("SYSTEM_HINT: You repeated the same action"));
    if (sawHint) return { text: "I refreshed my plan instead of asking you to do it." };
    calls++;
    return { toolCalls: [{ name: "browser_click", arguments: { ref: "e1" } }] };
  };
  const out = await runAgent([{ role: "user", content: "go" }], {
    step,
    execute: async () => "clicked",
    confirm: async () => true,
    currentUrl: () => ORIGIN,
    maxSteps: 6,
  });
  assert.equal(out.stoppedReason, "done");
  assert.match(out.finalText, /refreshed my plan/i);
  assert.ok(calls >= 2);
});

test("abort between steps stops the loop", async () => {
  const signal = { aborted: false };
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_snapshot", arguments: {} }] },
    { text: "should not reach here" },
  ]);
  const out = await runAgent([{ role: "user", content: "go" }], {
    step,
    execute: async () => {
      signal.aborted = true; // user hits Stop while the tool runs
      return "snap";
    },
    confirm: async () => true,
    currentUrl: () => ORIGIN,
    signal,
  });
  assert.equal(out.stoppedReason, "aborted");
});

// discovered (generated-server) tools used live in-session
const cartTool = {
  name: "add_to_cart",
  description: "Add an item to the cart",
  inputSchema: { type: "object", properties: { sku: { type: "string" }, qty: { type: "number" } }, required: ["sku"] },
  execution: {
    kind: "http",
    request: { method: "POST", urlPattern: "/api/cart/{sku}", rawUrl: "https://shop.example.com/api/cart/1", requestHeaders: { accept: "application/json" }, statusCode: 200, contentType: "application/json" },
    paramMapping: { sku: { in: "path", key: "sku" }, qty: { in: "body", key: "quantity" } },
  },
  confidence: 0.7,
};
const searchToolDef = {
  name: "search_products",
  description: "Search",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  execution: {
    kind: "http",
    request: { method: "GET", urlPattern: "/s", rawUrl: "https://shop.example.com/s", requestHeaders: {}, statusCode: 200, contentType: "text/html" },
    paramMapping: { q: { in: "query", key: "k" } },
  },
  confidence: 0.7,
};

test("discoveredToolSpecs converts tool defs to model function-specs", () => {
  const specs = discoveredToolSpecs([cartTool, searchToolDef, { name: "bad" }]);
  assert.deepEqual(specs.map((s) => s.name), ["add_to_cart", "search_products"]); // the malformed one (no inputSchema) is skipped
  assert.equal(specs[0].parameters.type, "object");
});

test("isMutatingHttpTool flags state-changing methods", () => {
  assert.equal(isMutatingHttpTool(cartTool), true); // POST
  assert.equal(isMutatingHttpTool(searchToolDef), false); // GET
});

test("httpRequestFromTool maps path/query/body params (session-credentialed)", () => {
  const { url, init } = httpRequestFromTool(cartTool.execution, { sku: "B0ABC", qty: 2 });
  assert.equal(url, "https://shop.example.com/api/cart/B0ABC");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "include");
  assert.deepEqual(JSON.parse(init.body), { quantity: 2 });

  const get = httpRequestFromTool(searchToolDef.execution, { q: "shoes" });
  assert.match(get.url, /\/s\?k=shoes$/);
});

test("a custom needsConfirm gate confirms a mutating discovered tool", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "add_to_cart", arguments: { sku: "B0ABC" } }] },
    { text: "Added." },
  ]);
  let confirmed: any = null;
  let executed = 0;
  const mutating = new Set(["add_to_cart"]);
  await runAgent([{ role: "user", content: "add it" }], {
    step,
    execute: async () => {
      executed++;
      return "ok";
    },
    confirm: async (call) => {
      confirmed = call.name;
      return true;
    },
    currentUrl: () => ORIGIN,
    needsConfirm: (call: any, url: string) => needsConfirm(call, url) || mutating.has(call.name),
  });
  assert.equal(confirmed, "add_to_cart", "mutating discovered tool must be confirmed");
  assert.equal(executed, 1);
});

test("pruneForModel keeps only the latest tool result full, collapsing older ones", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "user", content: "TOOL_RESULT browser_snapshot:\nPAGE: Home\n[e1] link \"A\"\n[e2] button \"B\"" },
    { role: "assistant", content: "looking" },
    { role: "user", content: "TOOL_RESULT browser_click:\nPAGE: Results\n[e1] link \"X\"\n[e2] link \"Y\"" },
  ];
  const pruned = pruneForModel(messages);
  // the EARLIER snapshot is collapsed to one line; the LATEST stays full
  assert.equal(pruned[1].content, "TOOL_RESULT browser_snapshot: (earlier output omitted)");
  assert.match(pruned[3].content, /PAGE: Results/);
  assert.match(pruned[3].content, /\[e2\] link "Y"/);
  // non-tool messages untouched, original not mutated
  assert.equal(pruned[0].content, "go");
  assert.equal(pruned[2].content, "looking");
  assert.match(messages[1].content, /\[e1\] link "A"/);
});

test("over a multi-step turn the model never receives more than one full snapshot", async () => {
  const step = scriptedStep([
    { toolCalls: [{ name: "browser_snapshot", arguments: {} }] },
    { toolCalls: [{ name: "browser_click", arguments: { ref: "e1" } }] },
    { text: "done" },
  ]);
  await runAgent([{ role: "user", content: "go" }], {
    step,
    execute: async (call) => `PAGE: ${call.name}\n[e1] button "x"\n[e2] link "y"\nlots of detail here`,
    confirm: async () => true,
    currentUrl: () => ORIGIN,
  });
  // third model call: at most ONE message still carries a full snapshot body (the most recent)
  const thirdCall = step.seen[2];
  const fullSnapshots = thirdCall.filter((m: any) => typeof m.content === "string" && /\[e2\] link "y"/.test(m.content));
  assert.equal(fullSnapshots.length, 1, "only the latest snapshot should be full");
});

test("parseStepResponse tolerates messy bodies", () => {
  assert.deepEqual(parseStepResponse({ text: "hi", toolCalls: [] }), { text: "hi", toolCalls: [] });
  assert.deepEqual(parseStepResponse({ text: "   " }).text, undefined);
  const p = parseStepResponse({ toolCalls: [{ name: "browser_click", arguments: { ref: "e1" } }, { bad: true }, { name: "x" }] });
  assert.equal(p.toolCalls.length, 2);
  assert.deepEqual(p.toolCalls[0], { id: undefined, name: "browser_click", arguments: { ref: "e1" } });
  assert.deepEqual(p.toolCalls[1].arguments, {});
  assert.deepEqual(parseStepResponse(null), { text: undefined, toolCalls: [] });
});
