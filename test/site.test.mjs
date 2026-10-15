import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import fs from "node:fs";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { website, SITE, WEBSITE_USER_AGENT } from "../lib/site.mjs";

const cert = fs.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
const key = fs.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));

async function localSite(t, handler, trust = true) {
  const server = http2.createSecureServer({ cert, key });
  const sessions = new Set();
  server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => { stream.on("error", () => {}); handler(stream, headers); });
  server.on("sessionError", () => {});
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const session of sessions) session.destroy(); server.close(); });
  const connect = http2.connect;
  t.mock.method(http2, "connect", (origin, options) => {
    assert.equal(origin, SITE);
    assert.equal(options?.createConnection, undefined);
    return connect(`https://127.0.0.1:${server.address().port}`, {
      servername: "localhost", ...(trust ? { ca: cert } : {}),
    });
  });
}

test("website uses real HTTP/2, minimal headers, bounded decoding and manual redirects", async t => {
  const seen = [];
  await localSite(t, (stream, headers) => {
    seen.push(headers);
    assert.equal(stream.session.socket.alpnProtocol, "h2");
    assert.equal(headers["user-agent"], WEBSITE_USER_AGENT);
    assert.equal(headers.cookie, "session=synthetic");
    assert.equal(headers.referer, undefined);
    if (headers[":path"].includes("redirect")) {
      stream.respond({ ":status": 302, location: "https://other.test/secret" }); stream.end();
    } else {
      stream.respond({ ":status": 200, "content-type": "application/json", "content-encoding": "gzip" });
      stream.end(gzipSync('{"ok":true}'));
    }
  });
  const response = await website.fetch(SITE + "/api/apikeys?page=2", { headers: { Cookie: "session=synthetic" } });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.has("content-encoding"), false);
  assert.equal(seen[0][":path"], "/api/apikeys?page=2");
  const redirect = await website.fetch(SITE + "/api/wallet?redirect", { headers: { Cookie: "session=synthetic" } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://other.test/secret");
  for (const input of ["https://other.test/api/wallet", SITE + "/other", "http://www.aicodemirror.ai/api/wallet", "https://user:secret@www.aicodemirror.ai/api/wallet"]) {
    await assert.rejects(website.fetch(input), /地址或方法无效/);
  }
  assert.equal(seen.length, 2);
});

test("website aborts while reading the body and handles resets", async t => {
  await localSite(t, (stream, headers) => {
    if (headers[":path"].includes("slow")) {
      stream.respond({ ":status": 200 }); stream.write("partial");
    } else stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });
  const controller = new AbortController();
  const pending = website.fetch(SITE + "/api/wallet?slow", { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(website.fetch(SITE + "/api/wallet?reset"), /HTTP\/2/);
});

test("website enforces compressed and uncompressed response limits", async t => {
  await localSite(t, (stream, headers) => {
    const compressed = headers[":path"].includes("gzip");
    stream.respond({ ":status": 200, ...(compressed ? { "content-encoding": "gzip" } : {}) });
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    stream.end(compressed ? gzipSync(bytes) : bytes);
  });
  for (const query of ["raw", "gzip"]) await assert.rejects(website.fetch(SITE + "/api/wallet?" + query), /HTTP\/2/);
});

test("website verifies TLS certificates and does not fall back to HTTP/1.1", async t => {
  await localSite(t, stream => { stream.respond({ ":status": 200 }); stream.end("unexpected"); }, false);
  await assert.rejects(website.fetch(SITE + "/api/wallet"), /HTTP\/2/);
});
