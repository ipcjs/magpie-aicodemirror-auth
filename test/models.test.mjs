import test from "node:test";
import assert from "node:assert/strict";
import { AICodeMirrorAuthPlugin } from "../index.mjs";
import { baseURL, listKeys, boundModels, modelLoader, catalog } from "../lib/api.mjs";

const cookie = "session=website-secret";
const key = { id: "k1", name: "cli", apiKey: "sk-model-secret", isActive: true, expiresAt: null,
  availableModelCount: 4, bindings: ["CLAUDECODE", "CODEX", "GEMINI", "GROK"].map((product, i) => ({ product, channelId: i + 1, channelIsActive: true })) };
const groups = ["CLAUDECODE", "CODEX", "GEMINI", "GROK"].map((code, i) => ({ code,
  channels: [{ id: i + 1, isActive: true, models: ["model-" + i, "blocked"], unavailableModels: ["blocked"] }] }));
const models = groups.map((g, i) => ({ id: "model-" + i, product: g.code }));
function fakeFetch(url, init) {
  const path = new URL(url).pathname;
  if (path === "/api/auth/session") return Response.json({ user: { username: "Alice", id: "u1" } });
  if (path === "/api/apikeys") return Response.json({ success: true, data: [key], total: 1 });
  if (path === "/api/apikeys/channel-options") return Response.json({ success: true, data: groups });
  if (path === "/v1/models") {
    assert.equal(init.headers.Authorization, "Bearer " + key.apiKey);
    assert.equal(init.headers.Cookie, undefined);
    return Response.json({ data: [...models, { id: "unbound" }, { id: "blocked" }] });
  }
  if (path === "/api/wallet") return Response.json({ success: true, data: { balance: 1000, bonusBalance: 2000 } });
  throw new Error("Unexpected test endpoint");
}

test("full dynamic login keeps secrets off choices and saves one combined account", async t => {
  t.mock.method(globalThis, "fetch", async (...args) => fakeFetch(...args));
  const plugin = await AICodeMirrorAuthPlugin();
  const method = plugin.auth.methods[0];
  const inputs = {};
  for (const [field, answer] of [["cookie", cookie], ["keyId", "k1"], ["route", "global"], ["balanceDisplay", "paygo"]]) {
    const prompt = await method.ask(inputs);
    assert.equal(prompt.key, field);
    assert.ok(!JSON.stringify(prompt).includes(key.apiKey));
    inputs[field] = answer;
  }
  assert.equal(await method.ask(inputs), null);
  const flow = await method.authorize(inputs);
  assert.equal(flow.method, "auto");
  const saved = await flow.callback();
  assert.equal(saved.type, "success");
  assert.equal(saved.access, cookie);
  assert.equal(saved.apiKey, key.apiKey);
  assert.equal(saved.baseURL, "https://api.aicodemirror.ai");
  assert.equal(saved.accountId, "Alice · cli · 按量");
  assert.equal(saved.uid, "u1:k1");
  assert.deepEqual(saved.boundModels, models);
  const auth = { ...saved, type: "oauth" };
  const usage = await plugin.auth.usage(async () => auth);
  assert.equal(usage.balance, "¥2.00");
  assert.equal(usage.user, saved.accountId);
  assert.equal(usage.signIn, "kept");
  const result = await plugin.provider.models({}, { auth });
  assert.equal(Object.keys(result).length, 4);
  assert.equal(result["model-0"].api.npm, "@ai-sdk/anthropic");
  assert.equal(result["model-1"].api.npm, "@ai-sdk/openai");
  assert.equal(result["model-2"].api.url, "https://api.aicodemirror.ai/v1beta");
  assert.equal(result["model-3"].api.npm, "@ai-sdk/openai-compatible");
});

test("custom root validation and changed key status fail before saving", async t => {
  for (const root of ["http://example.com", "https://u:p@example.com", "https://example.com/v1", "https://example.com?token=x", "bad"]) assert.throws(() => baseURL(root));
  assert.equal(baseURL("https://example.com/"), "https://example.com");
  let active = true;
  t.mock.method(globalThis, "fetch", async (url, init) => new URL(url).pathname === "/api/apikeys"
    ? Response.json({ success: true, data: [{ ...key, isActive: active }], total: 1 }) : fakeFetch(url, init));
  const method = (await AICodeMirrorAuthPlugin()).auth.methods[0];
  assert.equal((await method.ask({ cookie, keyId: "k1", route: "custom" })).key, "baseURL");
  const flow = await method.authorize({ cookie, keyId: "k1", route: "global", balanceDisplay: "all" });
  active = false;
  assert.equal((await flow.callback()).type, "failed");
  await assert.rejects(method.ask({ cookie }), /没有有效/);
});

test("key pagination filters disabled and expired keys without leaking errors", async t => {
  const pages = [];
  t.mock.method(globalThis, "fetch", async url => {
    const page = Number(new URL(url).searchParams.get("page")); pages.push(page);
    return Response.json({ success: true, total: 21, data: page === 1 ? [
      key, { ...key, id: "disabled", isActive: false }, { ...key, id: "expired", expiresAt: "2000-01-01" },
    ] : [{ ...key, id: "next" }] });
  });
  assert.deepEqual((await listKeys(cookie)).map(k => k.id), ["k1", "next"]);
  assert.deepEqual(pages, [1, 2]);
  t.mock.method(globalThis, "fetch", async () => new Response(cookie, { status: 401 }));
  await assert.rejects(listKeys(cookie), e => e.status === 401 && !e.message.includes(cookie));
});

test("channel filtering excludes unavailable and inactive bindings", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: groups }));
  const result = await boundModels(cookie, { ...key, bindings: key.bindings.map((b, i) => ({ ...b, channelIsActive: i !== 1 })) });
  assert.deepEqual(result.map(m => m.id), ["model-0", "model-2", "model-3"]);
});

test("transport signs each protocol, strips website credentials and preserves stream", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(await new Response(init.body).text(), '{"stream":true}');
    return new Response("data: first\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const auth = { apiKey: key.apiKey, baseURL: "https://api.aicodemirror.ai", access: cookie };
  const loader = modelLoader(async () => auth);
  for (const [path, header] of [["/v1/messages", "x-api-key"], ["/v1/responses", "authorization"], ["/v1/chat/completions", "authorization"], ["/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=wrong", "x-goog-api-key"]]) {
    const result = await loader.fetch(auth.baseURL + path, { method: "POST", body: '{"stream":true}',
      headers: { Cookie: cookie, Authorization: "wrong", "x-api-key": "wrong", "x-goog-api-key": "wrong" } });
    assert.match(await result.text(), /data: first/);
    const sent = calls.at(-1);
    assert.equal(sent.init.headers.get(header), header === "authorization" ? `Bearer ${key.apiKey}` : key.apiKey);
    assert.equal(sent.init.headers.get("cookie"), null);
    assert.equal(sent.init.redirect, "manual");
    assert.ok(!sent.url.includes("key="));
    for (const other of ["authorization", "x-api-key", "x-goog-api-key"].filter(h => h !== header)) assert.equal(sent.init.headers.get(other), null);
  }
  for (const url of ["https://evil.test/v1/messages", auth.baseURL + "/api/wallet", auth.baseURL + "/v1/messages/extra"]) {
    await assert.rejects(loader.fetch(url, { method: "POST", body: "{}" }), /不属于/);
  }
  assert.equal(calls.length, 4);
});

test("transport keeps upstream failures and cancels without exposing secrets", async t => {
  const loader = modelLoader(async () => ({ apiKey: key.apiKey, baseURL: "https://api.aicodemirror.ai" }));
  t.mock.method(globalThis, "fetch", async () => new Response("quota", { status: 429 }));
  const input = new Request("https://api.aicodemirror.ai/v1/responses", { method: "POST", body: "{}" });
  assert.equal((await loader.fetch(input)).status, 429);
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, "fetch", async (_url, init) => { assert.ok(init.signal.aborted); throw new Error(key.apiKey); });
  await assert.rejects(loader.fetch("https://api.aicodemirror.ai/v1/responses", { method: "POST", body: "{}", signal: controller.signal }), e => e.name === "AbortError" && !e.message.includes(key.apiKey));
});

test("expired website session does not expire API auth or drop saved model bindings", async t => {
  t.mock.method(globalThis, "fetch", async url => new URL(url).pathname.startsWith("/api/")
    ? new Response(null, { status: 401 }) : Response.json({ data: models }));
  const plugin = await AICodeMirrorAuthPlugin();
  const auth = { type: "oauth", access: cookie, apiKey: key.apiKey, keyId: "k1", keyName: "cli",
    baseURL: "https://api.aicodemirror.ai", boundModels: models };
  assert.equal((await plugin.auth.usage(async () => auth)).signIn, "kept");
  assert.equal(Object.keys(await plugin.provider.models({}, { auth })).length, 4);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const fallback = await plugin.provider.models({}, { auth });
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(plugin.provider.models({}, { auth }), e => e.signIn === "expired");
  assert.deepEqual(await plugin.provider.models({}, { auth: { type: "oauth", access: cookie } }), {});
});

test("catalog limits and capabilities may be overridden without changing credential destination", () => {
  const result = catalog(models, "https://api.aicodemirror.ai", new Set(["model-1"]), {
    "model-1": { limit: { context: 64000, output: 8000 }, capabilities: { reasoning: true }, variants: { high: {} } },
  });
  assert.equal(result["model-1"].limit.context, 64000);
  assert.equal(result["model-1"].capabilities.reasoning, true);
  assert.equal(Object.keys(result).length, 1);
});
