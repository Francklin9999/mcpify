// Unit check (no network): the multi-provider abstraction resolves correctly. Run: node test/providers.mjs
import assert from "node:assert";
import { resolveProvider } from "../dist/src/providers.js";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok: ${name}`); } catch (e) { failed++; console.error(`  FAIL: ${name} -> ${e.message}`); }
};

// Clean slate for key envs we assert on.
for (const k of ["OPENAI_API_KEY", "GROQ_API_KEY", "FORGE_MODEL", "VLLM_BASE_URL"]) delete process.env[k];

check("hosted provider without key -> null (caller falls back)", () => {
  assert.strictEqual(resolveProvider("groq"), null);
});

check("groq with key -> groq base url + default model", () => {
  process.env.GROQ_API_KEY = "x";
  const r = resolveProvider("groq");
  assert.strictEqual(r.baseURL, "https://api.groq.com/openai/v1");
  assert.strictEqual(r.model, "llama-3.3-70b-versatile");
  assert.strictEqual(r.apiKey, "x");
  delete process.env.GROQ_API_KEY;
});

check("provider/model pin overrides default", () => {
  process.env.GROQ_API_KEY = "x";
  const r = resolveProvider("groq", "llama-3.1-8b-instant");
  assert.strictEqual(r.model, "llama-3.1-8b-instant");
  delete process.env.GROQ_API_KEY;
});

check("FORGE_MODEL overrides default when no pin", () => {
  process.env.GROQ_API_KEY = "x";
  process.env.FORGE_MODEL = "mixtral";
  assert.strictEqual(resolveProvider("groq").model, "mixtral");
  delete process.env.GROQ_API_KEY; delete process.env.FORGE_MODEL;
});

check("ollama: local, no key required, placeholder key", () => {
  const r = resolveProvider("ollama");
  assert.strictEqual(r.baseURL, "http://localhost:11434/v1");
  assert.strictEqual(r.apiKey, "ollama");
  assert.strictEqual(r.model, "llama3.1");
});

check("openai: default base url (undefined) when key present", () => {
  process.env.OPENAI_API_KEY = "x";
  const r = resolveProvider("openai");
  assert.strictEqual(r.baseURL, undefined);
  delete process.env.OPENAI_API_KEY;
});

check("unknown provider -> null", () => {
  assert.strictEqual(resolveProvider("definitely-not-a-provider"), null);
});

check("openai-compatible escape hatch needs FORGE_OPENAI_BASE_URL", () => {
  delete process.env.FORGE_OPENAI_BASE_URL;
  assert.throws(() => resolveProvider("openai-compatible"));
  process.env.FORGE_OPENAI_BASE_URL = "http://my-gateway/v1";
  const r = resolveProvider("openai-compatible");
  assert.strictEqual(r.baseURL, "http://my-gateway/v1");
  delete process.env.FORGE_OPENAI_BASE_URL;
});

check("vllm honors VLLM_BASE_URL", () => {
  process.env.VLLM_BASE_URL = "http://gpu-box:8000/v1";
  assert.strictEqual(resolveProvider("vllm").baseURL, "http://gpu-box:8000/v1");
  delete process.env.VLLM_BASE_URL;
});

check("ollama honors OLLAMA_URL + OLLAMA_MODEL (doc/code parity)", () => {
  process.env.OLLAMA_URL = "http://box:11434/v1";
  process.env.OLLAMA_MODEL = "qwen2.5-coder";
  const r = resolveProvider("ollama");
  assert.strictEqual(r.baseURL, "http://box:11434/v1");
  assert.strictEqual(r.model, "qwen2.5-coder");
  delete process.env.OLLAMA_URL; delete process.env.OLLAMA_MODEL;
});

check("FORGE_MODEL beats a provider's modelEnv", () => {
  process.env.OLLAMA_MODEL = "from-ollama-env";
  process.env.FORGE_MODEL = "from-forge";
  assert.strictEqual(resolveProvider("ollama").model, "from-forge");
  delete process.env.OLLAMA_MODEL; delete process.env.FORGE_MODEL;
});

check("openai honors OPENAI_MODEL", () => {
  process.env.OPENAI_API_KEY = "x";
  process.env.OPENAI_MODEL = "gpt-4.1";
  assert.strictEqual(resolveProvider("openai").model, "gpt-4.1");
  delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL;
});

// selectInference: default is host-brain; provider/model parses; missing key falls back to heuristic.
const { selectInference } = await import("../dist/src/select-inference.js");

check("default (no env) -> host-brain", () => {
  for (const k of ["FORGE_INFERENCE", "FORGE_INFERENCE_URL"]) delete process.env[k];
  const s = selectInference();
  assert.strictEqual(s.mode, "host");
  assert.strictEqual(s.hostBrain, true);
});

check("FORGE_INFERENCE=groq/model with key -> groq", () => {
  process.env.FORGE_INFERENCE = "groq/llama-3.1-8b-instant";
  process.env.GROQ_API_KEY = "x";
  const s = selectInference();
  assert.strictEqual(s.mode, "groq");
  assert.ok(s.label.includes("llama-3.1-8b-instant"));
  delete process.env.FORGE_INFERENCE; delete process.env.GROQ_API_KEY;
});

check("FORGE_INFERENCE=openai without key -> heuristic fallback (no crash)", () => {
  process.env.FORGE_INFERENCE = "openai";
  delete process.env.OPENAI_API_KEY;
  assert.strictEqual(selectInference().mode, "heuristic");
  delete process.env.FORGE_INFERENCE;
});

if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log("\nPASS: provider abstraction resolves correctly across hosted, local, custom, and fallback paths.");
