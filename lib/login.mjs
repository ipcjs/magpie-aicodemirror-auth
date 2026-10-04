import { normalizeCookie, balanceDisplay } from "./wallet.mjs";
import { queryAccount, displayAccount } from "./account.mjs";
import { APIError, ROUTES, baseURL, listKeys, boundModels, listModelIDs } from "./api.mjs";

const cookiePrompt = { type: "text", key: "cookie", message: "粘贴 AICodeMirror 网站 Cookie（此输入框为明文）",
  placeholder: "登录 https://www.aicodemirror.ai 后，复制 /api/wallet 请求的 Cookie" };

function rootOf(inputs) {
  if (inputs.route === "custom") return baseURL(inputs.baseURL);
  if (!(inputs.route in ROUTES)) throw new APIError("请选择有效线路。");
  return ROUTES[inputs.route];
}

async function selection(inputs) {
  const cookie = normalizeCookie(inputs.cookie);
  const [account, keys] = await Promise.all([queryAccount(cookie), listKeys(cookie)]);
  if (!keys.length) throw new APIError("没有有效 API Key，请先在 AICodeMirror 网站创建或启用一个 Key。");
  const key = keys.find(item => String(item.id) === inputs.keyId);
  return { cookie, account, keys, key };
}

export function loginMethod(options = {}) {
  return {
    type: "oauth",
    label: "Cookie 登录并选择 API Key",
    // Magpie passes inputs to authorize only if prompts is nonempty. Other hosts
    // see the initial prompt, but this multi-step flow requires Magpie's ask hook.
    prompts: [cookiePrompt],
    async ask(inputs = {}) {
      if (!inputs.cookie) return cookiePrompt;
      const { keys, key } = await selection(inputs);
      if (!inputs.keyId) return {
        type: "select", key: "keyId", message: "选择 API Key",
        options: keys.map(item => ({ value: String(item.id), label: item.name || "未命名 Key",
          hint: `${item.expiresAt ? "到期 " + item.expiresAt : "永不过期"} · ${item.availableModelCount ?? "未知"} 个渠道模型` })),
      };
      if (!key) throw new APIError("所选 API Key 已失效或不属于当前账户，请取消后重新选择。");
      if (!inputs.route) return { type: "select", key: "route", message: "选择模型 API 线路（代理在 Magpie 中设置）",
        options: [{ label: "全球线路", value: "global", hint: ROUTES.global },
          { label: "国内优化线路", value: "china", hint: ROUTES.china },
          { label: "自定义 HTTPS 根地址", value: "custom" }] };
      if (inputs.route === "custom" && !inputs.baseURL) return { type: "text", key: "baseURL",
        message: "模型 API 根地址（所选 API Key 将发送到此地址）", placeholder: "https://api.example.com" };
      rootOf(inputs);
      if (!inputs.balanceDisplay) return { type: "select", key: "balanceDisplay",
        message: "显示哪种余额？（插件 options 设置优先）",
        options: [{ label: "总余额", value: "all" }, { label: "仅订阅余额", value: "subscription" }, { label: "仅按量余额", value: "paygo" }] };
      balanceDisplay(options.balanceDisplay ?? inputs.balanceDisplay);
      return null;
    },
    async authorize(inputs) {
      if (!inputs?.keyId || !inputs.route || !inputs.balanceDisplay) {
        throw new APIError("请在支持动态登录的 Magpie 中依次输入 Cookie、选择 Key、线路和余额类型。");
      }
      return {
        url: "", method: "auto", instructions: "正在验证所选 Key 和模型列表…",
        async callback() {
          try {
            // Re-read on commit: never save a revoked key or trust UI-provided secrets.
            const { cookie, account, key } = await selection(inputs);
            if (!key) throw new APIError("所选 API Key 已失效，请重新选择。");
            const root = rootOf(inputs);
            const [bindings, ids] = await Promise.all([boundModels(cookie, key), listModelIDs(root, key.apiKey)]);
            const models = bindings.filter(model => ids.has(model.id));
            if (!models.length) throw new APIError("所选 Key 在此线路没有可用模型，请检查渠道配置。");
            const display = balanceDisplay(inputs.balanceDisplay);
            return { type: "success", access: cookie, refresh: "", expires: 0,
              apiKey: key.apiKey, keyId: String(key.id), keyName: key.name || "未命名 Key",
              baseURL: root, boundModels: models, balanceDisplay: display,
              ...displayAccount({ ...account, keyName: key.name || "未命名 Key",
                uid: `${account.uid || account.accountId}:${key.id}` }, options.balanceDisplay ?? display) };
          } catch (error) {
            return { type: "failed", error: error instanceof APIError ? error.message : "登录未完成，请检查 Cookie 和网站登录状态。" };
          }
        },
      };
    },
  };
}
