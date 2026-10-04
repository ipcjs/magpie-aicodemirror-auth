import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const cache = path.join(os.homedir(), ".cache", "magpie");
const hosts = path.join(cache, "plugin-host");
const host = process.env.MAGPIE_TEST_HOST || (fs.existsSync(hosts) ? fs.readdirSync(hosts).filter(x => /^host-.*\.js$/.test(x)).map(x => path.join(hosts, x)).sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : undefined);
const bunRoot = path.join(cache, "bun");
const bun = process.env.MAGPIE_TEST_BUN || (fs.existsSync(bunRoot) ? fs.readdirSync(bunRoot).map(x => path.join(bunRoot, x, process.platform === "win32" ? "bun.exe" : "bun")).find(x => fs.existsSync(x)) : undefined);

test("installed Magpie host runs dynamic login, stores credentials and exposes model protocols", { skip: !host || !bun, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicm-host-test-"));
  const preload = path.join(dir, "vendor.mjs");
  fs.writeFileSync(preload, `
globalThis.fetch = async (input, init) => {
 const u = new URL(input instanceof Request ? input.url : input);
 const json = x => Promise.resolve(Response.json(x));
 if(u.pathname === '/api/auth/session') return json({user:{id:'u1',name:'Alice'}});
 if(u.pathname === '/api/apikeys') return json({success:true,total:1,data:[{id:'k1',name:'cli',apiKey:'sk-synthetic',isActive:true,expiresAt:null,bindings:[{product:'CODEX',channelId:1}]}]});
 if(u.pathname === '/api/apikeys/channel-options') return json({success:true,data:[{code:'CODEX',channels:[{id:1,isActive:true,models:['gpt-test'],unavailableModels:[]}]}]});
 if(u.pathname === '/v1/models') return json({data:[{id:'gpt-test'}]});
 if(u.pathname === '/api/wallet') return json({success:true,data:{balance:1000,bonusBalance:2000}});
 if(u.pathname === '/v1/responses') {
   const h = new Headers(init.headers);
   if(h.get('authorization') !== 'Bearer sk-synthetic' || h.has('cookie')) throw new Error('Wrong credential');
   return new Response('data: test\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 }
 throw new Error('Unexpected test endpoint');
};`);
  const child = spawn(bun, ["--preload", preload, host], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
  const provider = "aicodemirror-balance";
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
  assert.ok(!text.includes("sk-synthetic"));
  const usage = await rpc("usage", { provider, account: saved.account });
  assert.equal(usage.balance, "¥2.00");
  assert.equal(usage.user, "Alice · cli · 按量");
  await rpc("fetch", { provider, account: saved.account, model: "gpt-test", npm: "@ai-sdk/openai", url: "https://api.aicodemirror.ai/v1/responses", method: "POST", body: Buffer.from('{"model":"gpt-test","input":"test","stream":true}').toString("base64") });
  assert.ok(events.some(e => e.event === "head" && e.status === 200));
  assert.ok(events.some(e => e.event === "chunk" && Buffer.from(e.data, "base64").toString().includes("data: test")));
});
