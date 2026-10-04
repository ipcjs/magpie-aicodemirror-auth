import { balanceDisplay, queryWallet, usageError } from "./lib/wallet.mjs";
import { displayAccount, queryAccount } from "./lib/account.mjs";
import { loginMethod } from "./lib/login.mjs";
import { APIError, catalog, listModelIDs, modelLoader, listKeys, boundModels } from "./lib/api.mjs";

// Export only the plugin: Magpie calls every function exported by this module.
export const AICodeMirrorAuthPlugin = async (_input, options = {}) => ({
  async config(config) {
    config.provider ??= {};
    config.provider["aicodemirror"] ??= {
      name: "AICodeMirror",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.aicodemirror.ai/v1",
      models: {},
    };
  },
  auth: {
    provider: "aicodemirror",
    methods: [loginMethod(options)],
    async loader(getAuth) { return modelLoader(getAuth); },
    async usage(getAuth) {
      try {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || !auth.access) {
          return { error: "请登录并导入 AICodeMirror Cookie。", signIn: auth?.apiKey ? "kept" : "expired", windows: [] };
        }
        const display = balanceDisplay(options.balanceDisplay ?? auth.balanceDisplay);
        const [usage, account] = await Promise.all([
          queryWallet(auth.access, {
            display,
          }),
          // A temporary identity lookup failure must not hide a valid balance.
          queryAccount(auth.access).catch(() => null),
        ]);
        const identity = account ? { ...account, ...(auth.keyName ? { keyName: auth.keyName } : {}),
          uid: auth.keyId ? `${account.uid || account.accountId}:${auth.keyId}` : account.uid,
        } : (auth.accountId ? {
          accountId: auth.accountId, accountName: auth.accountName, uid: auth.uid, keyName: auth.keyName,
        } : null);
        const named = identity ? displayAccount(identity, display) : null;
        if (named && (named.accountId !== auth.accountId || named.uid !== auth.uid || named.accountName !== auth.accountName)) {
          const latest = await getAuth();
          if (latest?.access === auth.access && latest.keyId === auth.keyId && latest.apiKey === auth.apiKey
            && latest.balanceDisplay === auth.balanceDisplay && _input?.client?.auth?.set) {
            try {
              await _input.client.auth.set({
                path: { id: "aicodemirror" }, body: { ...latest, ...named },
              });
            } catch { /* Still show the verified identity if persistence fails. */ }
          }
        }
        // Website session health must never clear or expire model API authentication.
        return { ...usage, ...(auth.apiKey ? { signIn: "kept" } : {}), ...(named ? { user: named.accountId } : {}) };
      } catch (error) {
        const failure = usageError(error);
        const auth = await getAuth();
        return { ...failure, ...(auth?.apiKey ? { signIn: "kept" } : {}) };
      }
    },
  },
  provider: {
    id: "aicodemirror",
    async models(_provider, { auth } = {}) {
      if (!auth?.apiKey || !auth.baseURL || !Array.isArray(auth.boundModels)) return {};
      let bindings = auth.boundModels;
      // Refresh channel choices when the website session works. Saved bindings
      // remain usable when it expires, independently of the model credential.
      try {
        const key = (await listKeys(auth.access)).find(k => String(k.id) === auth.keyId);
        if (key) bindings = await boundModels(auth.access, key);
      } catch { /* Keep the last confirmed channel bindings. */ }
      try {
        const ids = await listModelIDs(auth.baseURL, auth.apiKey);
        return catalog(bindings, auth.baseURL, ids, options.modelOverrides);
      } catch (error) {
        if (error instanceof APIError && error.status === 401) {
          throw Object.assign(new Error("API Key 已失效，请重新登录选择。"), { signIn: "expired" });
        }
        const fallback = catalog(bindings, auth.baseURL, null, options.modelOverrides);
        fallback[Symbol.for("magpie.fellBack")] = true;
        return fallback;
      }
    },
  },
});
