import { normalizeCookie, queryWallet, usageError } from "./lib/wallet.mjs";

// Export only the plugin: Magpie calls every function exported by this module.
export const AICodeMirrorAuthPlugin = async () => ({
  async config(config) {
    config.provider ??= {};
    config.provider.aicodemirror ??= {
      name: "AICodeMirror 余额",
      models: {},
    };
  },
  auth: {
    provider: "aicodemirror",
    methods: [{
      type: "oauth",
      label: "网页登录并导入 Cookie（查询余额）",
      async authorize() {
        return {
          url: "https://www.aicodemirror.com/login",
          method: "code",
          instructions: "登录后打开浏览器开发者工具 → Network，刷新余额页，复制 /api/wallet 请求的 Cookie 请求头值并粘贴。不是 API Key，也不是验证码。",
          async callback(code) {
            try {
              const cookie = normalizeCookie(code);
              await queryWallet(cookie);
              // Magpie's OAuth storage is used for an imported website session.
              // No refresh token exists; an expired cookie must be imported again.
              return { type: "success", access: cookie, refresh: "", expires: 0 };
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
        return await queryWallet(auth.access);
      } catch (error) {
        return usageError(error);
      }
    },
  },
});
