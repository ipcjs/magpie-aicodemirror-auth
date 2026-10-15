import { balanceDisplay, normalizeCookie } from "./wallet.mjs";
import { APIError } from "./api.mjs";
import { challengeMessage, website } from "./site.mjs";

export function displayAccount(account, display) {
  const label = { all: "", subscription: "订阅", paygo: "按量" }[balanceDisplay(display)];
  // Keep the raw website name separately so changing options never stacks suffixes.
  const accountName = account.accountName ?? account.accountId;
  return { ...account, accountName, accountId: [accountName, account.keyName, label].filter(Boolean).join(" · ") };
}

export function parseAccount(payload) {
  const user = payload?.user;
  // Some accounts expose only their phone login, with no name or username.
  const accountId = [user?.username, user?.name, user?.email, user?.phone]
    .find(value => typeof value === "string" && value.trim());
  if (!accountId) throw new Error("账户接口未返回用户名或登录账号。");
  return {
    accountId: accountId.trim(),
    ...(typeof user.id === "string" && user.id ? { uid: user.id } : {}),
  };
}

export async function queryAccount(cookie, { fetchImpl = website.fetch } = {}) {
  try {
    const response = await fetchImpl("https://www.aicodemirror.ai/api/auth/session", {
      headers: { Accept: "application/json", Cookie: normalizeCookie(cookie) },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const challenge = challengeMessage(response);
    if (challenge) throw new APIError(challenge, response.status);
    if (response.status === 401 || response.status === 403) {
      throw new APIError(`账户接口拒绝访问（HTTP ${response.status}），请检查网站登录状态并重新导入 Cookie。`, response.status);
    }
    if (!response.ok) throw new APIError(`获取 AICodeMirror 用户名失败（HTTP ${response.status}），请稍后重试。`, response.status);
    let payload;
    try { payload = await response.json(); }
    catch { throw new APIError("账户接口未返回 JSON，请检查网站访问限制或稍后重试。"); }
    try { return parseAccount(payload); }
    catch { throw new APIError("账户接口未返回用户名或登录账号，请检查网站登录状态；若网站已登录，可能是接口格式发生变化。"); }
  } catch (error) {
    // Session responses may include access tokens: never expose their body.
    if (error instanceof APIError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new APIError("获取 AICodeMirror 用户名超时，请稍后重试。");
    }
    throw new APIError("无法获取 AICodeMirror 用户名，请检查网络或代理设置。");
  }
}
