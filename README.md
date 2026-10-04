# opencode-aicodemirror-auth

在 **Magpie** 中查看 AICodeMirror 网站账户余额的零依赖插件。

- 显示订阅剩余余额和按量剩余余额，保留到厘（¥0.001）。
- 使用每个账户单独保存的网站 Cookie，支持 Magpie 多账户。
- 查询超时、网站拒绝访问、非 JSON、接口异常时给出错误，不显示伪造的零余额。

这是**余额查询专用供应商**，不会增加可调用模型。已有 AICodeMirror 模型供应商继续使用自己的 API Key；余额会显示在新添加的插件账户上，不会合并到已有自定义供应商。插件采用 OpenCode 插件结构，但 `auth.usage` 是 Magpie 扩展，原生 OpenCode 不会显示这些余额。

## 安装

需要支持 `auth.usage` 的 Magpie。无需 npm install 或构建。

在本项目目录执行：

```powershell
magpie plugin add .
magpie plugin login aicodemirror
magpie quota
```

也可以在 Magpie 设置 → Plugins 添加本项目的绝对目录，然后通过插件供应商入口登录 **AICodeMirror 余额**。不要移动或删除已添加的目录；本地插件从原目录加载。修改代码后，在 GUI 中关闭再开启插件。

## 登录

余额接口使用**网站登录 Cookie**，不是用于模型调用的 `sk-…` API Key。

1. 选择“网页登录并导入 Cookie（查询余额）”，浏览器打开 AICodeMirror 登录页。
2. 登录并进入显示余额的页面。
3. 打开浏览器开发者工具 → Network，刷新页面，找到 `/api/wallet` 请求。
4. 在 Request Headers 中复制 **Cookie** 的完整单行值，粘贴回插件登录输入框。也接受以 `Cookie:` 开头的整行。不要复制响应的 `Set-Cookie` 或整个请求。
5. 插件会先查询余额；成功后才保存会话。随后可在 Providers 账户及 `magpie quota` 查看余额。

示例显示：`订阅剩余 ¥197.713 · 按量剩余 ¥1.851`。

Cookie 是账户凭据，请仅粘贴到本地插件登录框，不要发到聊天、日志或提交到仓库。插件使用宿主的 OAuth 会话存储字段保存导入的 Cookie；这不是自动 OAuth 登录，也没有自动续期。会话过期后重新登录并导入 Cookie。

## 数据和限制

读取固定地址 `https://www.aicodemirror.com/api/wallet`，发送 Cookie，预期响应为：

```json
{"success":true,"data":{"balance":"197713","bonusBalance":"1851"}}
```

`balance` 为订阅余额，`bonusBalance` 为按量余额，均按整数厘转换为元。缺失一项只显示另一项；缺失全部或格式不合法时报错。

已知接口只返回余额，没有套餐总额度、已用金额、用量百分比或重置日期，因此插件不会编造这些字段，也不会显示误导性的进度条或固定的“PRO”套餐名。

接口依据 [AiCodeMirror-Monitor 的 BalanceService](https://github.com/zzzhizhia/AiCodeMirror-Monitor/blob/main/AiCodeMirror%20Monitor/Services/BalanceService.swift) 独立实现；插件协议依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins)。该网站接口没有版本化保证，网站修改后可能需要更新插件。

仅向上述固定 HTTPS 地址发送 Cookie，禁止自动跟随重定向；15 秒超时。不带 `www` 的旧地址会返回 301，因此登录和查询均直接使用 `www` 地址。不会记录 Cookie、网站响应正文或原始网络错误，也不会将会话用于模型请求。

## 验证

Node.js 20+：

```powershell
npm test
npm run check
npm pack --dry-run
```

测试使用模拟接口，覆盖金额精度、字段缺失、错误响应、凭据隔离、超时和登录回调。真实账户余额及 Magpie GUI 显示仍需使用有效 Cookie 验证。
