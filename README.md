# opencode-aicodemirror-auth

一个 Magpie 供应商，同时提供 **AICodeMirror 模型调用和账户余额**。零运行时依赖，无需构建。

## 安装与升级

```powershell
magpie plugin add .
magpie plugin login aicodemirror-balance
```

显示名为 **AICodeMirror**，ID 沿用 `aicodemirror-balance`，避免与已有自定义供应商冲突。已验证 Magpie 0.1.824 的动态登录接口。原生 OpenCode 不支持此流程所需的 Magpie `ask` / `auth.usage` 扩展。

本地插件从原目录加载。升级后请在 **Magpie GUI 的 Plugins 中关闭再开启插件，或重启 GUI**；在终端开关插件不一定重载已运行的 GUI。

旧余额账户继续查询余额。要启用模型，请重新执行本插件登录流程，选择 API Key；插件不会自动替你选择 Key。新登录按真实网站账户和所选 Key 区分，支持多个 Key。旧余额条目如仍存在，可在确认新账户正常后手动移除。

## 添加账户

1. 登录 https://www.aicodemirror.ai ，打开开发者工具 → Network，刷新钱包页面，复制 `/api/wallet` 请求的 **Cookie 请求头值**。
2. 在 Magpie 选择 **Cookie 登录并选择 API Key**，粘贴 Cookie。
3. 验证会话后选择 Key 名称。禁用或过期的 Key 不参与选择，选项仅包含名称、ID 和提示，不含完整密钥。
4. 选择全球线路、国内优化线路或自定义 HTTPS 根地址。
5. 选择总余额、订阅或按量。插件验证所选线路的模型列表后完成添加。

**Magpie 的普通提问框目前为明文输入，Cookie 不会自动遮蔽。** 不要在共享屏幕时输入，不要把 Cookie 或 Key 发到聊天、日志或仓库。输入错误导致步骤失败时，可取消后重试。

API Key 从网站接口获取，无需手动复制。凭据保存在宿主 `plugin-auth.json`：`access` 为 Cookie，`apiKey` 为所选模型密钥。模型接口只发送 API Key，网站接口只发送 Cookie。Cookie 过期后模型调用仍可使用已保存 Key；重新登录可更新 Cookie 或切换 Key。

账号显示如 `真实账号名 · cli · 按量`；优先使用网站用户名、名称、邮箱，再回退到手机号。余额字段仍为纯金额。

## 线路和模型

| 线路 | 根地址 |
| --- | --- |
| 全球 | `https://api.aicodemirror.ai` |
| 国内优化 | `https://api.claudecode.net.cn` |
| 自定义 | 明确填写的 HTTPS 根地址，不含 `/v1` 等路径 |

代理沿用 Magpie 设置，不自动切换线路或重试生成请求。网站 API 固定为 `https://www.aicodemirror.ai`，不随模型线路改变。

Key 渠道绑定的模型与所选线路 `/v1/models` 的交集决定模型列表，排除禁用渠道和 `unavailableModels`。协议依据产品代码确定，不按模型名称猜测：

| 产品 | 协议 | 生成接口 |
| --- | --- | --- |
| CLAUDECODE | Anthropic Messages | `/v1/messages` |
| CODEX | OpenAI Responses | `/v1/responses` |
| GEMINI | Gemini | `/v1beta/models/{model}:generateContent` 或 `streamGenerateContent` |
| GROK | OpenAI Chat Completions | `/v1/chat/completions` |

保留流式响应、工具调用请求内容和取消信号；上游状态交由 Magpie 处理。网站会话失效时使用已保存渠道绑定；模型目录暂不可用时回退到已知绑定。API Key 被上游拒绝时提示重新登录。

模型列出不保证网站渠道允许所有客户端。Claude SDK 文档要求适用于 Claude Code 之外场景的渠道；如渠道仅允许官方客户端，需要用户在网站选择兼容渠道。插件不会改动网站渠道或冒充官方客户端。

上游目录不提供上下文或最大输出长度。插件使用保守默认值（上下文 32768、输出 4096），不是模型真实上限。可在插件条目的 `options.modelOverrides` 提供已确认的能力：

```json
{
  "options": {
    "modelOverrides": {
      "你的模型ID": {
        "limit": { "context": 65536, "output": 8192 },
        "capabilities": { "reasoning": true },
        "variants": { "high": { "reasoningEffort": "high" } }
      }
    }
  }
}
```

图像、音频和视频等额外能力未默认声明。接口来源：[Claude](https://www.aicodemirror.ai/dashboard/sdk-docs)、[OpenAI](https://www.aicodemirror.ai/dashboard/openai-sdk-docs)、[Gemini](https://www.aicodemirror.ai/dashboard/gemini-sdk-docs)、[Grok](https://www.aicodemirror.ai/dashboard/grok-api)、[Magpie 插件文档](https://usemagpie.ai/docs/plugins)。

## 余额显示

| `balanceDisplay` | 金额 | 账号后缀 |
| --- | --- | --- |
| `all`（默认） | 订阅 + 按量余额 | 无后缀 |
| `subscription` | 订阅余额 | 订阅 |
| `paygo` | 按量余额 | 按量 |

选项随账户保存，也可编辑 `~/.config/magpie/plugins.json`（遵循 `XDG_CONFIG_HOME`），在已有插件条目添加 `options.balanceDisplay`，覆盖所有账户的展示：

```json
{
  "spec": "C:\\Users\\ipcjs\\Documents\\Codex\\opencode-aicodemirror-auth",
  "options": { "balanceDisplay": "paygo" }
}
```

这只是 `plugins` 数组中的一个条目，不要覆盖整个文件。修改后重载 GUI 插件，终端下次运行即加载。余额选项只影响展示，不决定扣费来源。

`/api/wallet` 的 `balance` 为订阅余额，`bonusBalance` 为按量余额，单位整数厘。总额先精确相加再转为元，最多显示三位小数；缺少所选字段时报错，不推算用量比例和重置日期。

## 验证

```powershell
npm test
npm run check
npm pack --dry-run
magpie quota aicodemirror-balance
```

测试覆盖动态登录、分页和失效 Key、渠道过滤、各协议认证、流式转发、取消、余额与模型认证隔离。若本机有 Magpie 缓存的 Bun 和插件宿主，还会在临时目录以合成凭据、模拟网络运行完整宿主测试，不修改真实配置。其他机器可指定 `MAGPIE_TEST_HOST` 和 `MAGPIE_TEST_BUN`。

网站会话、Key 列表、渠道模型与 `/v1/models` 已完成真实只读验证。未执行付费生成；生成协议的认证、流式和取消通过模拟接口与实际 Magpie 宿主验证，真实生成仍取决于所选渠道权限和上游服务。
