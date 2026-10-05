import test from "node:test";
import assert from "node:assert/strict";
import { reasoningCatalog, withReasoning } from "../lib/reasoning.mjs";
import { catalog } from "../lib/api.mjs";

const effort = { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] };
const data = {
  openai: { models: { "gpt-test": effort } },
  anthropic: { models: { "claude-test": effort, "claude-budget": { reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024 }] } } },
  google: { models: { "gemini-test": effort } },
  xai: { models: { "grok-test": effort } },
};

test("reasoning uses exact maker entries and protocol-specific variants without changing limits or routes", () => {
  const metadata = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.models]));
  const models = withReasoning(catalog(["gpt-test", "claude-test", "gemini-test", "grok-test", "claude-budget", "unknown"], "https://example.com"), metadata);
  assert.deepEqual(models["gpt-test"].variants.high, { reasoningEffort: "high" });
  assert.deepEqual(models["grok-test"].variants.low, { reasoningEffort: "low" });
  assert.deepEqual(models["claude-test"].variants.high, { effort: "high" });
  assert.deepEqual(models["gemini-test"].variants.high, { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } });
  assert.equal(models["claude-budget"].capabilities.reasoning, true);
  assert.equal(models["claude-budget"].variants, undefined);
  assert.equal(models.unknown.capabilities, undefined);
  for (const model of Object.values(models)) {
    assert.equal(model.limit, undefined);
    assert.ok(model.api.url.startsWith("https://example.com/"));
  }
});

test("metadata requests are credential-free, shared, cached and retain stale data after failures", async () => {
  let time = 1, calls = 0, fail = false;
  const load = reasoningCatalog({ now: () => time, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://models.dev/api.json");
    assert.deepEqual(init.headers, { Accept: "application/json" });
    assert.equal(init.redirect, "error");
    if (fail) throw new Error("offline");
    return Response.json(data);
  } });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a, b);
  await load();
  assert.equal(calls, 1);
  time += 6 * 60 * 60 * 1000;
  fail = true;
  assert.equal(await load(), a);
  await load();
  assert.equal(calls, 2);
  time += 5 * 60 * 1000;
  await load();
  assert.equal(calls, 3);
});

test("unavailable or malformed metadata does not prevent a model list", async () => {
  for (const response of [() => new Response(null, { status: 503 }), () => Response.json(null), () => Response.json({})]) {
    const load = reasoningCatalog({ fetchImpl: async () => response() });
    assert.deepEqual(await load(), {});
  }
});
