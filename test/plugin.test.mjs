import test from "node:test";
import assert from "node:assert/strict";
import { AICodeMirrorAuthPlugin } from "../index.mjs";
import { normalizeCookie, parseWallet, queryWallet, usageError } from "../lib/wallet.mjs";

const cookie = "__Secure-next-auth.session-token=test-session";
const wallet = { success: true, data: { balance: "197713", bonusBalance: "1851" } };

test("balances convert integer li to CNY without fabricated quota percentages", () => {
  assert.deepEqual(parseWallet(wallet), {
    balance: "¥199.564", windows: [], signIn: "renewed",
  });
  assert.equal(parseWallet({ success: true, data: { balance: 0, bonusBalance: -1000 } }).balance,
    "-¥1.00");
  assert.equal(parseWallet({ success: true, data: { balance: 0, bonusBalance: "12340" } }).balance, "¥12.34");
  assert.equal(parseWallet({ success: true, data: { balance: "9007199254740993123", bonusBalance: 0 } }).balance,
    "¥9007199254740993.123");
});

test("rejects invalid or missing balances instead of displaying zero", () => {
  for (const payload of [null, {}, { success: false, data: wallet.data }, { success: true, data: {} },
    ...["", "NaN", "1.5", true, {}, [], Number.MAX_SAFE_INTEGER + 1].map(balance => ({ success: true, data: { balance } }))]) {
    assert.throws(() => parseWallet(payload));
  }
});

test("display selection preserves zero and never substitutes another balance", () => {
  assert.equal(parseWallet(wallet, "subscription").balance, "¥197.713");
  assert.equal(parseWallet(wallet, "paygo").balance, "¥1.851");
  assert.equal(parseWallet({ success: true, data: { balance: 0 } }, "subscription").balance, "¥0.00");
  assert.throws(() => parseWallet({ success: true, data: { balance: 0 } }, "paygo"), /所选类型/);
  assert.throws(() => parseWallet(wallet, "invalid"), /设置无效/);
});

test("total sums exact li including carry, negative amounts and large balances", () => {
  const total = (balance, bonusBalance) => parseWallet({ success: true, data: { balance, bonusBalance } }, "all").balance;
  assert.equal(total("999", "1"), "¥1.00");
  assert.equal(total("9007199254740993123", "877"), "¥9007199254740994.00");
  assert.equal(total("-1001", "1"), "-¥1.00");
  assert.equal(total("-1", "1"), "¥0.00");
  for (const data of [{ balance: 1 }, { bonusBalance: 1 }, { balance: 1, bonusBalance: null }]) {
    assert.throws(() => parseWallet({ success: true, data }), /所选类型/);
  }
});

test("normalizes Cookie prefix, preserves chunked sessions, rejects invalid inputs", () => {
  assert.equal(normalizeCookie(`Cookie: ${cookie}`), cookie);
  assert.equal(normalizeCookie("session.0=abc; session.1=def=="), "session.0=abc; session.1=def==");
  for (const input of [undefined, "", "sk-api-key", "a=b\r\nx-secret: foo", "a=b\n", "a=b; invalid"]) {
    assert.throws(() => normalizeCookie(input));
  }
});

test("query sends cookie only to fixed wallet endpoint and disables redirects", async () => {
  const result = await queryWallet(cookie, { fetchImpl: async (url, init) => {
    assert.equal(url, "https://www.aicodemirror.ai/api/wallet");
    assert.equal(init.headers.Cookie, cookie);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(wallet);
  } });
  assert.equal(result.balance, "¥199.564");
});

test("expired credentials differ from transient errors and never leak response body", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    await assert.rejects(queryWallet(cookie, { fetchImpl: async () => new Response(cookie, { status }) }), error => {
      const result = usageError(error);
      assert.equal(result.signIn, [401, 403].includes(status) ? "expired" : "kept");
      assert.ok(!result.error.includes(cookie));
      return true;
    });
  }
});

test("Cloudflare challenges keep website authentication and explain the access restriction", async () => {
  await assert.rejects(queryWallet(cookie, { fetchImpl: async () => new Response(cookie, {
    status: 403, headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
  }) }), error => {
    const failure = usageError(error);
    assert.equal(failure.signIn, "kept");
    assert.match(failure.error, /Cloudflare/);
    assert.ok(!failure.error.includes(cookie));
    return true;
  });
});

test("non-JSON and network errors are sanitized", async () => {
  for (const fetchImpl of [async () => new Response(`<html>${cookie}</html>`), async () => { throw new Error(cookie); }]) {
    await assert.rejects(queryWallet(cookie, { fetchImpl }), error => {
      assert.ok(!usageError(error).error.includes(cookie));
      assert.equal(usageError(error).signIn, "kept");
      return true;
    });
  }
});

test("requests abort at configured deadline", async () => {
  // Keep the event loop alive because AbortSignal.timeout uses an unref'ed timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(queryWallet(cookie, {
      timeoutMs: 10,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }), /超时/);
  } finally { clearInterval(keepAlive); }
});

test("plugin config preserves existing provider and exposes no models by default", async () => {
  const plugin = await AICodeMirrorAuthPlugin();
  const config = {};
  assert.equal(plugin.auth.provider, "aicodemirror");
  await plugin.config(config);
  assert.deepEqual(config.provider["aicodemirror"].models, {});
  const custom = { name: "custom", models: { example: {} } };
  config.provider["aicodemirror"] = custom;
  await plugin.config(config);
  assert.equal(config.provider["aicodemirror"], custom);
  await assert.rejects((await plugin.auth.loader(async () => ({}))).fetch(), /尚未选择 API Key/);
});

test("combined provider uses the same ID and preserves existing model configuration", async () => {
  const plugin = await AICodeMirrorAuthPlugin();
  const existing = { name: "AICodeMirror", models: { example: {} }, options: { proxy: "direct" } };
  const config = { provider: { aicodemirror: existing } };
  await plugin.config(config);
  assert.equal(config.provider.aicodemirror, existing);
  assert.equal(plugin.provider.id, "aicodemirror");
  assert.equal(config.provider[plugin.auth.provider], existing);
  assert.deepEqual(config.provider[plugin.auth.provider].options, { proxy: "direct" });
});
