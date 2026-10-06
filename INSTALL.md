# DSH AI 润色插件 · 自包含安装手册

本文件的目的：**让任何一次安装都不需要打开 DSH 源码**。

打开 `node_modules/@deepseek-ai/**`（尤其 `dsh-client-ui-conversation/lib/client.js`，单文件 1.8 万行）
是安装过程中最贵的动作。2026-10-06 那次安装的实测：一次「读 SKILL.md + 模板」的调用就吃掉
**18,567 个新增输入 token**，占全会话新增输入的 6%；整次安装（含核对 API）合计新增输入 11 万 token。

**规则：装这个插件，只执行本文件里的命令。不要读 `node_modules` 下的任何 DSH 包源码。**

---

## 一、安装（3 条命令）

```powershell
# 0. 定位插件目录（本仓库已 clone 或已解压）
cd <本仓库根目录>            # 里面有 plugin\ 和 install.ps1

# 1. 复制 + 写入 profile（一条命令搞定，需要写 $DSH_HOME 的权限）
pwsh -NoProfile -File .\install.ps1

# 2. 校验：组合树里应有该插件行
dsh --profile web --dump-config | Select-String 'ai-polish'

# 3. 校验：运行中的 DSH 应返回当前模型路由（不需要重启）
curl.exe http://127.0.0.1:3080/dsh-ai-polish/status
```

第 3 条期望输出（模型名随你界面所选）：

```json
{"ok":true,"plugin":"dsh-plugin-ai-polish","maxDraftChars":12000,"route":{"provider":"deepseek-official","model":"deepseek-flash"}}
```

看到这行 **就说明 Host 半已生效**，不要再做任何额外探查。
客户端 UI：刷新一次页面，模型选择器左边出现「✨ AI 润色」即为完成。

## 二、安装后的自检（可选，只花本地 token，不调模型）

```powershell
# 空草稿保护：不应产生模型调用
'{"text":"   "}' | Set-Content -Encoding UTF8 $env:TEMP\p.json
curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@$env:TEMP\p.json" http://127.0.0.1:3080/dsh-ai-polish/polish
# 期望: {"ok":false,"error":"请先输入需要润色的内容"}
```

**不要**为了验证而做一次真实润色——那会花钱（约 393 tokens ≈ 2 厘）。空草稿分支足以证明路由与模型解析都通了。

## 三、卸载（1 条命令）

```powershell
dsh plugin --profile web remove dsh-plugin-ai-polish
```

---

## 四、故障速查（不要为此去读源码）

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `install.ps1` 报 `找不到插件目录` | 不在仓库根目录 | `cd` 到含 `plugin\` 的目录再执行 |
| `dsh: command not found` | dsh 不在 PATH | 用完整路径调用 `dsh` 可执行文件，或把它的目录加入 PATH |
| `status` 请求 404 | 进程还没加载新 bundle | 重启 `dsh web`（Host 半按启动时组合加载） |
| `status` 请求 401 | 你把端口占了给别的服务 | 确认 `http://127.0.0.1:3080` 是 DSH；本插件路由注册在鉴权 fallback 之前，正常不会是 401 |
| 页面看不到按钮 | 客户端 bundle 未加载 | 强刷页面（Ctrl+F5）；仍无则看浏览器 Console 首条报错，把报错原文贴给助手 |
| `无法确定当前会话使用的模型` | 会话未选模型 | 在界面里选一个模型后重试 |
| 润色报 `模型服务不可用` | `llm` 服务不可用 | 确认 DSH 能正常对话；不需要读源码排查 |

## 五、本插件为什么不需要读源码

它的全部对外依赖已经核对并冻结在下面这张表里（来自 2026-10-06 的实机核验）。
后续安装者**只需相信这张表**，不要重复验证：

| 契约 | 值 |
| --- | --- |
| 插件导出 | `export function apply(ctx)` + `export const inject = [...]` |
| 路由注册 | `ctx.webServer.register({ kind: 'exact', path, handler })` → 返回 disposer |
| 模型调用 | `ctx.llm.stream({ provider, model, system, messages, temperature, maxTokens, signal })` |
| 正文收集 | 只累加 `chunk.type === 'text-delta'`（`reasoning-delta` 也带 `text`，会污染结果） |
| 用量读取 | `chunk.type === 'usage'` → `chunk.usage`；`chunk.type === 'finish'` → `chunk.reason.kind` |
| 当前模型 | `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }` |
| token 估算兜底 | `ctx.tokenMeter.estimateMessage({ role, content })` → `number` |
| 槽位 | `conversation.input.right`、`conversation.composer.dock`（session 作用域 list） |
| 槽位标准 props | `useInput: SnapshotSelectorHook<InputState>`、`inputActions: InputActions`（含 `setDraft`） |
| 客户端 bundle | `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 内 `require('react')`；导出 `apply` / `inject` |

若某天升级了 DSH 且上面某条失效，**只让助手用 `grep` 精确查那一条**（例如只查 `stream(` 或 `currentSelection`），
不要整文件通读——这是本手册存在的意义。
