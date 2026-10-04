import test from "node:test";
import assert from "node:assert/strict";
import { parseAccount, queryAccount } from "../lib/account.mjs";
import { AICodeMirrorAuthPlugin } from "../index.mjs";

test("option changes rename cached account without stacking suffixes or changing its UID", async (t) => {
  t.mock.method(globalThis, "fetch", async url => url.endsWith("/session")
    ? new Response(null, { status: 503 }) : Response.json({ success: true, data: { balance: 1000, bonusBalance: 2000 } }));
  let auth = { type: "oauth", access: "session=one", accountId: "Alice", uid: "1", balanceDisplay: "paygo" };
  const client = { auth: { set: async ({ body }) => { auth = body; } } };
  for (const [mode, label, amount] of [["all", "", "¥3.00"], ["subscription", "订阅", "¥1.00"], ["paygo", "按量", "¥2.00"], ["all", "", "¥3.00"]]) {
    const plugin = await AICodeMirrorAuthPlugin({ client }, { balanceDisplay: mode });
    const result = await plugin.auth.usage(async () => auth);
    assert.equal(result.user, label ? `Alice · ${label}` : "Alice");
    assert.equal(auth.accountId, result.user);
    assert.equal(auth.accountName, "Alice");
    assert.equal(auth.uid, "1");
    assert.equal(auth.balanceDisplay, "paygo");
    assert.equal(result.balance, amount);
  }
});

test("real account fields are selected without retaining session tokens", () => {
  assert.deepEqual(parseAccount({ user: { id: "1", username: " alice ", name: "Other" }, accessToken: "secret" }), { accountId: "alice", uid: "1" });
  for (const [user, expected] of [[{ name: "Alice" }, "Alice"], [{ name: " ", email: "alice@example.test" }, "alice@example.test"], [{ phone: "13800000000" }, "13800000000"]]) {
    assert.equal(parseAccount({ user }).accountId, expected);
  }
  for (const data of [{}, { user: {} }, { user: { name: 123 } }]) assert.throws(() => parseAccount(data));
});

test("session requests stay on fixed origin and sanitize failures", async () => {
  await queryAccount("session=test", { fetchImpl: async (url, init) => {
    assert.equal(url, "https://www.aicodemirror.ai/api/auth/session");
    assert.equal(init.headers.Cookie, "session=test");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ user: { name: "Alice" } });
  } });
  for (const fetchImpl of [async () => new Response("secret", { status: 302 }), async () => new Response("secret"), async () => { throw new Error("secret"); }]) {
    await assert.rejects(queryAccount("session=test", { fetchImpl }), error => !error.message.includes("secret"));
  }
});

test("usage updates scoped identity preserving credentials and display preferences", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => Response.json(url.endsWith("/session")
    ? { user: { name: init.headers.Cookie === "session=one" ? "Alice" : "Bob", id: init.headers.Cookie } }
    : { success: true, data: { balance: 1000, bonusBalance: 2000 } }));
  const writes = [];
  const plugin = await AICodeMirrorAuthPlugin({ client: { auth: { set: async value => writes.push(value) } } });
  for (const [access, name] of [["session=one", "Alice"], ["session=two", "Bob"]]) {
    const auth = { type: "oauth", access, refresh: "", expires: 0, balanceDisplay: "paygo" };
    const usage = await plugin.auth.usage(async () => auth);
    assert.equal(usage.user, `${name} · 按量`);
    assert.equal(usage.balance, "¥2.00");
    assert.deepEqual(writes.at(-1), { path: { id: "aicodemirror" }, body: { ...auth, accountId: `${name} · 按量`, accountName: name, uid: access } });
    await plugin.auth.usage(async () => writes.at(-1).body);
  }
  assert.equal(writes.length, 2);
});

test("identity failure preserves balance and cached name; stale auth is not overwritten", async (t) => {
  let unavailable = true;
  t.mock.method(globalThis, "fetch", async url => url.endsWith("/session")
    ? unavailable ? new Response(null, { status: 503 }) : Response.json({ user: { name: "Bob" } })
    : Response.json({ success: true, data: { balance: 1, bonusBalance: 2 } }));
  const writes = [];
  const plugin = await AICodeMirrorAuthPlugin({ client: { auth: { set: async x => writes.push(x) } } });
  const auth = { type: "oauth", access: "session=old", accountId: "Alice · 总余额", accountName: "Alice" };
  const usage = await plugin.auth.usage(async () => auth);
  assert.equal(usage.user, "Alice");
  assert.equal(usage.balance, "¥0.003");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.accountId, "Alice");
  writes.length = 0;
  unavailable = false;
  let reads = 0;
  await plugin.auth.usage(async () => ++reads === 1 ? auth : { ...auth, access: "session=new" });
  assert.equal(writes.length, 0);
});
