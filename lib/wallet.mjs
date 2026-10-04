// The bare domain redirects to www. Use the canonical origin directly so
// website session cookies never need to be forwarded through a redirect.
const WALLET_URL = "https://www.aicodemirror.com/api/wallet";

class WalletError extends Error {
  constructor(message, signIn = "kept") {
    super(message);
    this.signIn = signIn;
  }
}

export function normalizeCookie(input) {
  if (typeof input !== "string" || /[\r\n\x00]/.test(input)) {
    throw new WalletError("请粘贴单行 Cookie 请求头值。");
  }
  const cookie = input.trim().replace(/^cookie:\s*/i, "");
  if (!cookie || !cookie.split(";").every((part) => /^\s*[^\s=;,]+=[\x21-\x3A\x3C-\x7E]*\s*$/.test(part))) {
    throw new WalletError("Cookie 格式无效，请复制 /api/wallet 的 Cookie 请求头值，不能使用 API Key。");
  }
  return cookie;
}

function money(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new WalletError("余额数据无效：预期整数厘。");
  }
  if (!(["string", "number"].includes(typeof value)) || !/^-?\d+$/.test(String(value))) {
    throw new WalletError("余额数据无效：预期整数厘。");
  }
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = String(absolute % 1000n).padStart(3, "0").replace(/0$/, "");
  return `${amount < 0n ? "-" : ""}¥${absolute / 1000n}.${fraction}`;
}

export function parseWallet(payload) {
  if (payload?.success !== true || !payload.data || typeof payload.data !== "object") {
    throw new WalletError("AICodeMirror 未返回有效余额数据，请检查网站登录状态。");
  }
  const fields = [["balance", "订阅剩余"], ["bonusBalance", "按量剩余"]];
  const parts = fields
    .filter(([key]) => payload.data[key] !== undefined && payload.data[key] !== null)
    .map(([key, label]) => `${label} ${money(payload.data[key])}`);
  if (!parts.length) throw new WalletError("AICodeMirror 响应缺少余额字段。");
  // The wallet has no plan total, reset time or used percentage. Do not invent them.
  return { balance: parts.join(" · "), windows: [], signIn: "renewed" };
}

export async function queryWallet(cookie, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const headers = { Accept: "application/json", Cookie: normalizeCookie(cookie) };
  try {
    const response = await fetchImpl(WALLET_URL, {
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      throw new WalletError("网站拒绝访问（HTTP " + response.status + "），请检查登录状态并重新导入 Cookie。", "expired");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new WalletError("余额接口发生重定向，请检查网站地址或登录状态；未转发 Cookie。");
    }
    if (!response.ok) throw new WalletError(`余额查询失败（HTTP ${response.status}），请稍后重试。`);
    let payload;
    try { payload = await response.json(); }
    catch { throw new WalletError("余额接口未返回 JSON，请检查网站登录状态或访问限制。"); }
    return parseWallet(payload);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new WalletError("余额查询超时，请稍后重试。");
    }
    // Never expose response bodies, request headers, or upstream exception messages.
    throw new WalletError("无法连接 AICodeMirror，请检查网络或代理设置。");
  }
}

export function usageError(error) {
  return {
    error: error instanceof WalletError ? error.message : "余额查询失败，请稍后重试。",
    signIn: error instanceof WalletError ? error.signIn : "kept",
    windows: [],
  };
}
