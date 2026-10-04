import { balanceDisplay, normalizeCookie, queryWallet, usageError } from "./lib/wallet.mjs";
import { displayAccount, queryAccount } from "./lib/account.mjs";

// Export only the plugin: Magpie calls every function exported by this module.
export const AICodeMirrorAuthPlugin = async (_input, options = {}) => ({
  async config(config) {
    config.provider ??= {};
    config.provider["aicodemirror-balance"] ??= {
      name: "AICodeMirror 余额",
      models: {},
    };
  },
  auth: {
    provider: "aicodemirror-balance",
    methods: [{
      type: "oauth",
      label: "网页登录并导入 Cookie（查询余额）",
      prompts: [{
        type: "select",
        key: "balanceDisplay",
        message: "显示哪种余额？（插件 options 设置优先）",
        options: [
          { label: "总余额", value: "all" },
          { label: "仅订阅余额", value: "subscription" },
          { label: "仅按量余额", value: "paygo" },
        ],
      }],
      async authorize(inputs) {
        return {
          url: "https://www.aicodemirror.com/login",
          method: "code",
          instructions: "登录后打开浏览器开发者工具 → Network，刷新余额页，复制 /api/wallet 请求的 Cookie 请求头值并粘贴。不是 API Key，也不是验证码。",
          async callback(code) {
            try {
              const cookie = normalizeCookie(code);
              const display = balanceDisplay(inputs?.balanceDisplay);
              const [, account] = await Promise.all([
                queryWallet(cookie, { display: balanceDisplay(options.balanceDisplay ?? display) }),
                queryAccount(cookie),
              ]);
              // Magpie's OAuth storage is used for an imported website session.
              // No refresh token exists; an expired cookie must be imported again.
              return { type: "success", access: cookie, refresh: "", expires: 0, balanceDisplay: display,
                ...displayAccount(account, options.balanceDisplay ?? display) };
            } catch (error) {
              return { type: "failed", error: usageError(error).error };
            }
          },
        };
      },
    }],
    async loader() {
      return {
        apiKey: "",
        async fetch() {
          throw new Error("此供应商仅查询余额；模型请求请使用单独配置的 AICodeMirror API 供应商。");
        },
      };
    },
    async usage(getAuth) {
      try {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || !auth.access) {
          return { error: "请登录并导入 AICodeMirror Cookie。", signIn: "expired", windows: [] };
        }
        const display = balanceDisplay(options.balanceDisplay ?? auth.balanceDisplay);
        const [usage, account] = await Promise.all([
          queryWallet(auth.access, {
            display,
          }),
          // A temporary identity lookup failure must not hide a valid balance.
          queryAccount(auth.access).catch(() => null),
        ]);
        const identity = account ?? (auth.accountId ? {
          accountId: auth.accountId, accountName: auth.accountName, uid: auth.uid,
        } : null);
        const named = identity ? displayAccount(identity, display) : null;
        if (named && (named.accountId !== auth.accountId || named.uid !== auth.uid || named.accountName !== auth.accountName)) {
          const latest = await getAuth();
          if (latest?.access === auth.access && latest.balanceDisplay === auth.balanceDisplay && _input?.client?.auth?.set) {
            try {
              await _input.client.auth.set({
                path: { id: "aicodemirror-balance" }, body: { ...latest, ...named },
              });
            } catch { /* Still show the verified identity if persistence fails. */ }
          }
        }
        return { ...usage, ...(named ? { user: named.accountId } : {}) };
      } catch (error) {
        return usageError(error);
      }
    },
  },
});
