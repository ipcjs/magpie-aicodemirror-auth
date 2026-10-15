import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import http2 from "node:http2";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { WEBSITE_USER_AGENT } from "../lib/site.mjs";

const cache = path.join(os.homedir(), ".cache", "magpie");
const hosts = path.join(cache, "plugin-host");
const host = process.env.MAGPIE_TEST_HOST || (fs.existsSync(hosts) ? fs.readdirSync(hosts).filter(x => /^host-.*\.js$/.test(x)).map(x => path.join(hosts, x)).sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : undefined);
const bunRoot = path.join(cache, "bun");
const bun = process.env.MAGPIE_TEST_BUN || (fs.existsSync(bunRoot) ? fs.readdirSync(bunRoot).sort().reverse().flatMap(x => ["magpie-bun", process.platform === "win32" ? "bun.exe" : "bun"].map(name => path.join(bunRoot, x, name))).find(x => fs.existsSync(x)) : undefined);

test("installed Magpie host runs dynamic login, stores credentials and exposes model protocols", { skip: !host || !bun, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicm-host-test-"));
  const certPath = fileURLToPath(new URL("./fixtures/localhost-cert.pem", import.meta.url));
  const server = http2.createSecureServer({ cert: fs.readFileSync(certPath),
    key: fs.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url)) });
  const requests = [];
  server.on("stream", (stream, headers) => {
    requests.push(headers);
    assert.equal(headers["user-agent"], WEBSITE_USER_AGENT);
    assert.equal(headers.cookie, "session=synthetic");
    assert.equal(headers.referer, undefined);
    assert.equal(headers.authorization, undefined);
    const path = new URL(headers[":path"], "https://www.aicodemirror.ai").pathname;
    const payload = path === "/api/auth/session" ? { user: { id: "u1", name: "Alice" } }
      : path === "/api/apikeys" ? { success: true, total: 1, data: [{ id: "k1", name: "cli", apiKey: "sk-synthetic", isActive: true, expiresAt: null }] }
      : { success: true, data: { balance: 1000, bonusBalance: 2000 } };
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tunnels = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    assert.equal(req.url, "www.aicodemirror.ai:443");
    tunnels.push(req.url);
    const upstream = net.connect(server.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => { proxy.close(); server.close(); });
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  const preload = path.join(dir, "vendor.mjs");
  fs.writeFileSync(preload, `
globalThis.fetch = async (input, init) => {
 const u = new URL(input instanceof Request ? input.url : input);
 const json = x => Promise.resolve(Response.json(x));
 if(u.hostname === 'models.dev') return json({openai:{models:{'gpt-test':{reasoning:true,reasoning_options:[{type:'effort',values:['low','high']}]}}}});
 if(u.pathname === '/v1/models') return json({data:[{id:'gpt-test'}]});
 if(u.pathname === '/v1/responses') {
   const h = new Headers(init.headers);
   if(h.get('authorization') !== 'Bearer sk-synthetic' || h.has('cookie')) throw new Error('Wrong credential');
   return new Response('data: test\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 }
 throw new Error('Unexpected test endpoint');
};`);
  const child = spawn(bun, ["--preload", preload, host], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, MAGPIE_HTTPS_PROXY: proxyURL, MAGPIE_HTTP_PROXY: proxyURL, MAGPIE_NO_PROXY: "" } });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
    }
    // Verify the resolved temporary target before recursive cleanup on Windows.
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("aicm-host-test-"));
    assert.ok(!fs.lstatSync(resolved).isSymbolicLink());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.event) { events.push(message); return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
  });
  child.stderr.resume();
  child.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error("Host exited")); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const authPath = path.join(dir, "auth.json");
  const loaded = await rpc("init", { authPath, directory: root, plugins: [{ spec: root, target: root }] });
  assert.equal(loaded.plugins[0].error, undefined);
  const provider = "aicodemirror";
  const inputs = {};
  for (const [key, value] of [["cookie", "session=synthetic"], ["keyId", "k1"], ["route", "global"], ["balanceDisplay", "paygo"]]) {
    const result = await rpc("prompt", { provider, method: 0, inputs });
    assert.equal(result.prompt.key, key);
    assert.ok(!JSON.stringify(result).includes("sk-synthetic"));
    inputs[key] = value;
  }
  assert.equal((await rpc("prompt", { provider, method: 0, inputs })).prompt, null);
  const flow = await rpc("authorize", { provider, method: 0, inputs });
  const saved = await rpc("callback", { session: flow.session });
  assert.equal(saved.ok, true);
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))[saved.account];
  assert.equal(auth.apiKey, "sk-synthetic");
  assert.equal(auth.accountId, "Alice · cli · 按量");
  const listed = await rpc("providers", {});
  const text = JSON.stringify(listed);
  assert.ok(text.includes("gpt-test"));
  assert.ok(text.includes("@ai-sdk/openai"));
  const listedModels = listed.providers?.flatMap(p => p.models ?? []) ?? listed.flatMap(p => p.models ?? []);
  const reasoningModel = listedModels.find(m => m.id === "gpt-test");
  assert.equal(reasoningModel.reasoning, true);
  assert.deepEqual(reasoningModel.variants, ["low", "high"]);
  assert.ok(!text.includes("sk-synthetic"));
  const usage = await rpc("usage", { provider, account: saved.account });
  assert.equal(usage.balance, "¥2.00");
  assert.equal(usage.user, "Alice · cli · 按量");
  await rpc("fetch", { provider, account: saved.account, model: "gpt-test", npm: "@ai-sdk/openai", url: "https://api.aicodemirror.ai/v1/responses", method: "POST", body: Buffer.from('{"model":"gpt-test","input":"test","stream":true}').toString("base64") });
  assert.ok(events.some(e => e.event === "head" && e.status === 200));
  assert.ok(events.some(e => e.event === "chunk" && Buffer.from(e.data, "base64").toString().includes("data: test")));
  assert.ok(requests.some(h => h[":path"] === "/api/wallet"));
  assert.ok(requests.some(h => h[":path"] === "/api/auth/session"));
  assert.equal(tunnels.length, requests.length);
});
