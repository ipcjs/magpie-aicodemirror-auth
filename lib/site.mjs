import http2 from "node:http2";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const SITE = "https://www.aicodemirror.ai";
export const WEBSITE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const MAX_BODY = 2 * 1024 * 1024;
const PATHS = new Set(["/api/auth/session", "/api/wallet", "/api/apikeys"]);

// Use the module object: current Magpie wraps http2.connect with its scoped proxy.
// Do not supply createConnection or cache sessions across account/proxy scopes.
export const website = {
  async fetch(input, { headers, signal = AbortSignal.timeout(15000), method = "GET" } = {}) {
    const url = new URL(input);
    if (url.origin !== SITE || url.username || url.password || !PATHS.has(url.pathname) || method !== "GET") {
      throw new Error("网站请求地址或方法无效。");
    }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let session, stream, settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        stream?.destroy();
        session?.destroy();
        if (error) reject(error); else resolve(response);
      };
      const fail = () => finish(new Error("网站 HTTP/2 请求失败，请检查 Magpie 版本、网络或代理设置。"));
      const abort = () => finish(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        session = http2.connect(SITE);
        session.on("error", fail);
        session.once("close", () => { if (!settled) fail(); });
        session.once("connect", () => {
          if (settled) return;
          try {
            const outgoing = new Headers(headers);
            outgoing.set("user-agent", WEBSITE_USER_AGENT);
            outgoing.set("accept", "application/json");
            // No Referer or invented browser client hints: these changed the
            // successful minimal request into a Cloudflare challenge in testing.
            stream = session.request({ ":method": "GET", ":path": url.pathname + url.search,
              ...Object.fromEntries(outgoing) });
            stream.on("error", fail);
            stream.once("aborted", fail);
            let incoming, size = 0;
            const chunks = [];
            stream.once("response", value => { incoming = value; });
            stream.on("data", chunk => {
              size += chunk.length;
              if (size > MAX_BODY) return fail();
              chunks.push(chunk);
            });
            stream.once("end", () => {
              if (settled) return;
              if (stream.rstCode) return fail();
              try {
                const status = incoming?.[":status"];
                if (!Number.isInteger(status)) return fail();
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(incoming ?? {})) {
                  if (key.startsWith(":")) continue;
                  for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, String(item));
                }
                let body = Buffer.concat(chunks);
                const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[responseHeaders.get("content-encoding")];
                if (decode) {
                  body = decode(body, { maxOutputLength: MAX_BODY });
                  responseHeaders.delete("content-encoding");
                  responseHeaders.delete("content-length");
                }
                finish(null, new Response([204, 205, 304].includes(status) ? null : body, { status, headers: responseHeaders }));
              } catch { fail(); }
            });
            stream.once("close", () => { if (!settled) fail(); });
            stream.end();
          } catch { fail(); }
        });
      } catch { fail(); }
    });
  },
};

// Cloudflare challenges are HTML responses even when JSON was requested.
export function challengeMessage(response) {
  if (response.headers.get("cf-mitigated")?.toLowerCase() !== "challenge") return null;
  return `AICodeMirror 被 Cloudflare 安全验证拦截（HTTP ${response.status}）。请在浏览器完成网站验证，确认 Magpie 与浏览器使用相同网络/代理后重新复制 Cookie；仍失败时需联系网站支持。`;
}
