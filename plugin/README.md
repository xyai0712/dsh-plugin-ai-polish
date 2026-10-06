# dsh-plugin-ai-polish v1.1.0（持久化安装形态）

> **v1.1.0 新增**：悬停预览（默认关闭）+ 右击 iOS 风设置菜单（默认关闭）。
> 装上后行为与 v1.0.0 完全一致，直到你右击按钮自己打开。
>
> **安装请先读仓库根目录的 [`../INSTALL.md`](../INSTALL.md)**（自包含手册：3 条命令 + 冻结的 API 契约）。
> 不要为了安装去通读 `node_modules/@deepseek-ai/**` 源码：实测那一次就花了 18,567 新增输入 token。

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

## 交互（v1.1.0）

三个动作，全部落在「✨ AI 润色」按钮上：

| 动作 | 行为 | 是否消耗 token |
| --- | --- | --- |
| **左键点击** | 有同草稿预览 → **直接采纳**；没有 → 即时润色并替换（= v1.0.0 行为）。草稿为空时给轻提示，不调模型 | 采纳缓存时 0；否则一次调用 |
| **右击** | 弹出 iOS 风设置菜单（原生右键菜单被拦掉） | 0 |
| **悬停 ≥250ms** | 当「悬停显示预览」已打开时，上方浮出预览卡片 | 每次生成一次调用；同草稿重复悬停 0 |

**右击菜单项**

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 悬停显示预览 | **关** | 开着才会在悬停时生成预览 |
| 显示消耗预估 | 开 | 预览卡片与右下角显示 token 数 |
| 长草稿自动预览上限 | 2000 字 | 点击循环 500 / 1000 / 2000 / 不限制；超过则不自动生成 |
| 立即重新生成 | — | 忽略缓存，手工再花一次调用 |
| 使用说明 | — | 菜单内原地展开三行说明（不联网、不打开外部文件） |

设置存在 `localStorage` 的 `dsh-ai-polish:prefs:v1`，刷新与重启后保留。

### 防被动烧 token 的五个闸门

1. **悬停触发是 `mouseenter`**（进入那一刻一次），不是每帧轮询——鼠标停着不动不产生任何事件
2. **re-entry gate**：每次"进入"最多自动生成一次；鼠标一直停着时，草稿被 DSH/助手改写**也不会**重新生成
3. **指纹缓存**：同草稿反复悬停 → 直接显示缓存，**0 token**
4. **在飞去重**：同一草稿请求未返回时，不再叠加新请求
5. **长草稿闸门**：超过上限只显示「点此生成」，要花这笔钱必须用户亲手点

另外**过期结果会被丢弃**（指纹不匹配时不显示旧版本），**草稿被改动时「采纳」按钮禁用**，绝不覆盖用户正在写的字。

### 按钮为什么常亮

v1.1.0 起按钮不再因为"草稿为空"而置灰——否则右击菜单也得先打字才能用，很别扭。
改为：**按钮常亮**，空草稿点击时在输入框上方弹出 2.2 秒轻提示「请先输入需要润色的内容」（纯本地，0 token）。
只有在 `inputActions.setDraft` 不可用（极端异常）时才真正禁用。

---

## 两个半边的文件分工

| 文件 | 角色 | 关键点 |
| --- | --- | --- |
| [package.json](package.json) | bundle 清单 | `dsh.bundle.patch` 声明 patch；`dsh.client` 声明 Web 端 bundle 与依赖的 UI 包 |
| [cordis.patch.yml](cordis.patch.yml) | 挂载声明 | `insert` 一行 `id: dsh-plugin-ai-polish` |
| [index.js](index.js) | Host 半 | `inject: ['llm','agentDefaultModel','tokenMeter','webServer']`；注册两条 HTTP 路由；`ctx.llm.stream()` 调模型 |
| [client.js](client.js) | Client 半 | `window.__ModuleLoader__.load({ id, factory })`；注册 `conversation.input.right`（按钮，含悬停与右击）、`conversation.input.overlay`（预览卡片 + 右击菜单）、`conversation.composer.dock`（token 统计）；用 `fetch` 调 Host 路由 |

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

- **不主动消耗 token**：只有点击「✨ AI 润色」、或（在已开启的前提下）悬停生成预览、或点「立即重新生成」才会发起一次模型调用；装载、打字、右击菜单、看缓存都只在本地计算。
- **耗时估算**：`ctx.tokenMeter.estimateMessage` 只在模型未回传 usage 时兜底。
- 预估是启发式（CJK ≈1.5 token/字），真实用量以模型回传的 `usage` 为准。
- `link:` 安装意味着 **DSH 启动时该目录必须存在**；删除插件目录会让 profile 报模块缺失，请用 `dsh plugin remove` 卸载。
- 修改 `client.js` / `index.js` 后需要重载页面（客户端）或重启 DSH（Host 半）。
