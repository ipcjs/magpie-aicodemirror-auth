import { balanceDisplay, normalizeCookie } from "./wallet.mjs";

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

export async function queryAccount(cookie, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl("https://www.aicodemirror.ai/api/auth/session", {
      headers: { Accept: "application/json", Cookie: normalizeCookie(cookie) },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    return parseAccount(await response.json());
  } catch {
    // Session responses may include access tokens: never expose their body.
    throw new Error("无法获取 AICodeMirror 用户名，请检查网站登录状态或稍后重试。");
  }
}
