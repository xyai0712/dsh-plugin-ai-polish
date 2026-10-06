# dsh-plugin-ai-polish（持久化安装形态）

本目录是「AI 润色」插件的**可安装 bundle**：装进 DSH profile 后，随 DSH 启动自动挂载，
不需要每次会话重新 `cordis_define`。

仓库 `../src/` 下是同功能的**动态插件**形态（`cordis_define` + `cordis_run`）；
两者 UI 与润色逻辑完全一致，只有 Client→Host 的通信通道不同。

---

## 安装

**一键**（推荐，脚本只做两件事：复制到 `$DSH_HOME/plugins` + `dsh plugin add`）：

```powershell
pwsh -NoProfile -File ..\install.ps1
```

**手工**

```powershell
# 1. 把本目录复制到 DSH 的插件目录（路径随意，这里跟随既有插件习惯）
Copy-Item . "$env:DSH_HOME\plugins\dsh-plugin-ai-polish" -Recurse -Force

# 2. 让 profile 以 link 方式安装它（同时自动写入 dsh.profile.bundles）
dsh plugin --profile web add "link:$env:DSH_HOME\plugins\dsh-plugin-ai-polish"
```

**验证**

```powershell
# 组合树里应出现该插件行
dsh --profile web --dump-config | Select-String 'ai-polish'
# 运行中的 DSH 上应返回路由与当前模型
curl.exe http://127.0.0.1:3080/dsh-ai-polish/status
```

**卸载**

```powershell
dsh plugin --profile web remove dsh-plugin-ai-polish
```

---

## 两个半边的文件分工

| 文件 | 角色 | 关键点 |
| --- | --- | --- |
| [package.json](package.json) | bundle 清单 | `dsh.bundle.patch` 声明 patch；`dsh.client` 声明 Web 端 bundle 与依赖的 UI 包 |
| [cordis.patch.yml](cordis.patch.yml) | 挂载声明 | `insert` 一行 `id: dsh-plugin-ai-polish` |
| [index.js](index.js) | Host 半 | `inject: ['llm','agentDefaultModel','tokenMeter','webServer']`；注册两条 HTTP 路由；`ctx.llm.stream()` 调模型 |
| [client.js](client.js) | Client 半 | `window.__ModuleLoader__.load({ id, factory })`；注册 `conversation.input.right` 按钮与 `conversation.composer.dock` token 统计；用 `fetch` 调 Host 路由 |

### HTTP 契约

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/dsh-ai-polish/polish` | `{ "text": "<草稿>" }` | `{ ok, text, usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens }, provider, model }` 或 `{ ok: false, error }` |
| GET | `/dsh-ai-polish/status` | — | `{ ok: true, plugin, maxDraftChars, route: { provider, model } }` |

两个路由都是 `kind: 'exact'`，注册在 SPA 的 fallback 之前，因此**不受页面自身的鉴权拦阻**；
但它们只监听 DSH web 的绑定地址（默认回环），且只做「用当前所选模型润色一段文本」，
不读写文件、不返回凭据。若你把 DSH 绑到 `0.0.0.0`，请自行评估这条本机接口的暴露面。

---

## 已核实的契约（对照本机 DSH 安装包）

- Cordis 插件导出：`export function apply(ctx, config)` + `export const inject = [...]`
- `ctx.webServer.register({ kind, path, handler })` → 返回 disposer；同 `(kind, path)` 重复注册会抛错
- `ctx.llm.stream(options)`：`GenerateOptions` 的 `provider` 与 `model` 必填，一次性调用用 `system` 承载指令
- `StreamChunk`：`text-delta { text }` / `usage { usage }` / `finish { reason }`；`reason.kind ∈ stop | tool-calls | max-tokens | aborted | error`
- `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }`（反映用户在界面上选中的模型）
- `ctx.tokenMeter.estimateMessage(message)` → `number`
- 槽位 `conversation.input.right` 与 `conversation.composer.dock`：session 作用域 `list`，
  标准 props 均含 `useInput: SnapshotSelectorHook<InputState>` 与 `inputActions: InputActions`
- Client bundle 协议：`window.__ModuleLoader__.load({ id, factory })`，factory 内 `require('react')`，
  模块导出 `apply` 与 `inject`

## 已知限制

- **不主动消耗 token**：只有点击「✨ AI 润色」才会发起一次模型调用；装载、打字、预估都只在本地计算。
- 预估是启发式（CJK ≈1.5 token/字），真实用量以模型回传的 `usage` 为准。
- `link:` 安装意味着 **DSH 启动时该目录必须存在**；删除插件目录会让 profile 报模块缺失，请用 `dsh plugin remove` 卸载。
- 修改 `client.js` / `index.js` 后需要重载页面（客户端）或重启 DSH（Host 半）。
