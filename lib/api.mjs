import { normalizeCookie } from "./wallet.mjs";

export const SITE = "https://www.aicodemirror.ai";
export const ROUTES = { global: "https://api.aicodemirror.ai", china: "https://api.claudecode.net.cn" };

export class APIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function baseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new APIError("baseURL 格式无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new APIError("baseURL 请填写 HTTPS 根地址，不包含 /v1、其他路径、账号或查询参数。");
  }
  return url.origin;
}

export async function jsonRequest(url, headers, label) {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", ...headers },
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new APIError(`${label}失败（HTTP ${response.status}）。`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw new APIError(`${label}失败，请检查网络、代理或稍后重试。`);
  }
}

export function availableKey(key, now = Date.now()) {
  return key?.isActive === true && typeof key.apiKey === "string" && !!key.apiKey.trim()
    && !/[\r\n]/.test(key.apiKey) && key.id != null
    && (key.expiresAt == null || (Number.isFinite(Date.parse(key.expiresAt)) && Date.parse(key.expiresAt) > now));
}

export async function listKeys(cookie) {
  const headers = { Cookie: normalizeCookie(cookie) };
  const keys = new Map();
  for (let page = 1; page <= 100; page++) {
    const result = await jsonRequest(`${SITE}/api/apikeys?page=${page}&pageSize=20&sortBy=createdAt&sortOrder=desc`, headers, "获取 API Key 列表");
    if (result.success !== true || !Array.isArray(result.data)) throw new APIError("API Key 列表格式无效。");
    for (const key of result.data) if (availableKey(key)) keys.set(String(key.id), key);
    if (result.data.length === 0 || (Number.isFinite(result.total) ? page * 20 >= result.total : result.data.length < 20)) return [...keys.values()];
  }
  throw new APIError("API Key 列表分页过多，请缩小账户的 Key 数量后重试。");
}

const PROTOCOLS = [
  { prefix: "claude-", npm: "@ai-sdk/anthropic", path: "/v1" },
  { prefix: "gpt-", npm: "@ai-sdk/openai", path: "/v1" },
  { prefix: "gemini-", npm: "@ai-sdk/google", path: "/v1beta" },
  { prefix: "grok-", npm: "@ai-sdk/openai-compatible", path: "/v1" },
];

export async function listModelIDs(root, key) {
  const response = await jsonRequest(`${baseURL(root)}/v1/models`, { Authorization: `Bearer ${key}` }, "读取模型列表");
  if (!Array.isArray(response.data)) throw new APIError("模型列表格式无效。");
  return new Set(response.data.filter(m => typeof m?.id === "string").map(m => m.id));
}

export function catalog(ids, root) {
  return Object.fromEntries([...ids].map(id => {
    const protocol = PROTOCOLS.find(p => id.startsWith(p.prefix));
    return [id, {
      id, name: id,
      api: { id, url: baseURL(root) + (protocol?.path ?? "/v1"),
        ...(protocol ? { npm: protocol.npm } : {}) },
      // Leave limits and capabilities unspecified so Magpie can use models.dev.
    }];
  }));
}

export function modelLoader(getAuth) {
  return {
    apiKey: "", // Each request is signed from the current account, never its website Cookie.
    async fetch(input, init) {
      const auth = await getAuth();
      if (!auth?.apiKey || !auth.baseURL) throw new APIError("此账户尚未选择 API Key，请重新登录并完成模型配置。");
      const root = baseURL(auth.baseURL);
      let request;
      try { request = new Request(input, init); } catch { throw new APIError("模型请求格式无效。"); }
      const url = new URL(request.url);
      const messages = url.pathname === "/v1/messages";
      const openai = ["/v1/responses", "/v1/chat/completions"].includes(url.pathname);
      const gemini = /^\/v1beta\/models\/[^/]+:(streamGenerateContent|generateContent)$/.test(url.pathname);
      if (url.origin === root && url.pathname === "/v1beta/chat/completions" && request.method === "POST") {
        throw new APIError("Gemini 需要原生 generateContent 接口；当前请求误用了 Chat Completions。Magpie 0.1.970 的 provider test 存在此限制，请通过本地网关或实际对话验证。");
      }
      if (url.origin !== root || url.username || url.password || request.method !== "POST" || !(messages || openai || gemini)) {
        throw new APIError("模型请求地址不属于此账户配置的接口。");
      }
      const headers = new Headers(request.headers);
      for (const name of ["cookie", "authorization", "x-api-key", "x-goog-api-key", "proxy-authorization"]) headers.delete(name);
      url.searchParams.delete("key");
      if (messages) {
        headers.set("x-api-key", auth.apiKey);
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      } else if (gemini) headers.set("x-goog-api-key", auth.apiKey);
      else headers.set("authorization", `Bearer ${auth.apiKey}`);
      try {
        return await fetch(url, { method: request.method, headers, body: request.body,
          duplex: "half", signal: request.signal, redirect: "manual" });
      } catch {
        if (request.signal.aborted) throw new DOMException("模型请求已取消。", "AbortError");
        throw new APIError("模型连接失败，请检查所选线路及 Magpie 代理设置。");
      }
    },
  };
}
