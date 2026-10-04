# opencode-aicodemirror-auth

在 **Magpie** 中查看 AICodeMirror 网站账户余额的零依赖插件。

- 可选择订阅余额、按量余额或两者合计；仅显示金额，保留到厘（¥0.001）。
- 使用每个账户单独保存的网站 Cookie，支持 Magpie 多账户。
- 查询超时、网站拒绝访问、非 JSON、接口异常时给出错误，不显示伪造的零余额。

这是**余额查询专用供应商**，不会增加可调用模型。已有 AICodeMirror 模型供应商继续使用自己的 API Key；余额会显示在新添加的插件账户上，不会合并到已有自定义供应商。插件采用 OpenCode 插件结构，但 `auth.usage` 是 Magpie 扩展，原生 OpenCode 不会显示这些余额。

供应商 ID 为 `aicodemirror-balance`，与模型供应商 `aicodemirror` 分开，避免同名供应商的代理设置和额度查询相互影响。网站在某些网络下需要代理；查询超时时请检查该余额供应商的代理设置。账户名称从 `https://www.aicodemirror.com/api/auth/session` 获取，依次采用用户名、名称、邮箱或登录手机号。登录时保存名称和网站用户 ID；已有账户下次查询余额时自动补全，无需重新登录。账户接口暂时不可用时保留已知名称和正常余额，不保存该接口返回的其他令牌。

从 0.1.1 或更早版本升级后，需要在新的 `aicodemirror-balance` 供应商下登录。模型供应商配置无需修改。

## 安装

需要支持 `auth.usage` 的 Magpie。无需 npm install 或构建。

在本项目目录执行：

```powershell
magpie plugin add .
magpie plugin login aicodemirror-balance
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

示例：订阅 ¥197.713、按量 ¥1.851，选择总余额时显示 `¥199.564`；选择单项时仅显示该项金额，不带“订阅剩余”或“按量剩余”前缀。

Cookie 是账户凭据，请仅粘贴到本地插件登录框，不要发到聊天、日志或提交到仓库。插件使用宿主的 OAuth 会话存储字段保存导入的 Cookie；这不是自动 OAuth 登录，也没有自动续期。会话过期后重新登录并导入 Cookie。

## 选择显示的余额

账号名会附带当前实际显示类型：`真实账号名 · 总余额`、`真实账号名 · 订阅` 或 `真实账号名 · 按量`。用量页的账号名也会显示该后缀，余额字段仍只显示金额。已有账户在查询余额时自动更新；修改选项后重新加载插件并刷新余额即可同步名称。网站原始账号名单独保存，切换选项不会重复追加后缀。

登录时会出现“显示哪种余额？”下拉选择：**总余额 / 仅订阅余额 / 仅按量余额**。选择随当前账户保存，旧账户默认总余额。这是登录流程中的选择项，不是在用量卡片内新增按钮。

已有账户也可以不用重新登录：在 Magpie 配置目录的 `plugins.json` 中，找到本插件的现有条目，添加或修改 `options.balanceDisplay`：

```json
{
  "spec": "C:\\Users\\ipcjs\\Documents\\Codex\\opencode-aicodemirror-auth",
  "options": { "balanceDisplay": "paygo" }
}
```

这只是 `plugins` 数组中单个条目的示例，**不要用它覆盖整个配置文件**；保留其他插件和设置。默认配置文件位于 `~/.config/magpie/plugins.json`，设置了 `XDG_CONFIG_HOME` 时位于其下的 `magpie/plugins.json`。

| 值 | 显示内容 |
| --- | --- |
| `all` | 总余额：订阅余额 + 按量余额（默认） |
| `subscription` | 仅订阅剩余 |
| `paygo` | 仅按量剩余 |

插件选项优先于登录时的账户选择，影响本插件所有账户；删除该选项恢复各账户选择。修改后重启 Magpie GUI，命令行下次运行即加载新配置。不需要再次导入 Cookie。接口缺少所选余额时明确报错，不会用另一种余额代替。

原“全部显示”的配置值 `all` 保持兼容，升级后自动显示总余额，无需修改已有设置。

## 数据和限制

读取固定地址 `https://www.aicodemirror.com/api/wallet`，发送 Cookie，预期响应为：

```json
{"success":true,"data":{"balance":"197713","bonusBalance":"1851"}}
```

`balance` 为订阅余额，`bonusBalance` 为按量余额，均按整数厘转换为元。总余额先以整数厘精确相加，再格式化为元。总余额模式要求两项均存在；所选余额缺失或格式不合法时报错。

已知接口只返回余额，没有套餐总额度、已用金额、用量百分比或重置日期，因此插件不会编造这些字段，也不会显示误导性的进度条或固定的“PRO”套餐名。

接口依据 [AiCodeMirror-Monitor 的 BalanceService](https://github.com/zzzhizhia/AiCodeMirror-Monitor/blob/main/AiCodeMirror%20Monitor/Services/BalanceService.swift) 独立实现；插件协议依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins)。该网站接口没有版本化保证，网站修改后可能需要更新插件。

仅向上述固定 HTTPS 地址发送 Cookie，禁止自动跟随重定向；余额查询 15 秒超时，账户查询 8 秒超时。不带 `www` 的旧地址会返回 301，因此登录和查询均直接使用 `www` 地址。不会记录 Cookie、网站响应正文或原始网络错误，也不会将会话用于模型请求。

## 验证

Node.js 20+：

```powershell
npm test
npm run check
npm pack --dry-run
```

测试使用模拟接口，覆盖金额精度、字段缺失、错误响应、凭据隔离、超时和登录回调。真实账户余额及 Magpie GUI 显示仍需使用有效 Cookie 验证。
