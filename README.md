# dsh-plugin-ai-polish

> 给 DeepSeek Harness（DSH）会话输入框加一个 **AI 润色** 按钮：把「心里有想法、嘴上说不清」的草稿，一键变成专业、正式、完整的表达，并在输入框右下角实时显示 token 消耗。

这是一个 [Cordis](https://github.com/deepseek-ai) 插件，有两种形态：**持久化 bundle**（装进 profile，随 DSH 启动自动挂载）与**动态插件**（`cordis_define` + `cordis_run`，随进程存活、停止即完全撤销）。

---

## 最近更新

> 更新时间：**2026-10-06 23:14（UTC+8）** · 当前版本 **v1.1.0** · 完整记录见 [CHANGELOG.md](CHANGELOG.md)

**✨ v1.1.0 新增**

- **悬停预览**：鼠标停在按钮上 250ms，输入框上方浮出润色结果，看不上就移开，草稿一字未动（默认关闭）
- **右击设置菜单**：iOS 风浮层，含开关预览、开关消耗预估、长草稿上限、立即重新生成、使用说明

**⚡ 优化**

- 按钮改为**常亮**（不再因草稿为空置灰），右击菜单随时可用；空草稿点击改为 2.2 秒轻提示
- 暗色模式浮层改用真实主题 token，修掉「浅色面板 + 深色字」

**🐞 修复**

- 右击菜单曾因预览状态为空而弹不出来
- 「立即重新生成」曾误显示为不可点
- 暗色下浮层露白（用了两个 DSH 主题里不存在的 token 名）

---

## 效果

在输入框里写下含糊的草稿：

```
我想问下那个 就是关于请假的事 能不能批 我下周有点事
```

点一下「✨ AI 润色」，输入框就地变成：

```
我想咨询一下请假事宜，我下周有些事情需要处理，请问能否批准？
```

实测用量回传（`deepseek-official` / `deepseek-flash`）：

```json
{
  "finishKind": "stop",
  "usage": { "inputTokens": 84, "outputTokens": 220, "totalTokens": 304 }
}
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| **按钮位置** | 模型选择器**紧左边**（`conversation.input.right` 槽位） |
| **一键润色** | 调用**当前会话所选模型**，保留原意、不改语言、专业正式 |
| **空输入保护** | 按钮**常亮**（右击菜单随时可用）；空草稿点击时在输入框上方给出 2.2 秒轻提示「请先输入需要润色的内容」，不消耗 token |
| **原稿保留 + 还原** | 润色后旁边出现 `↺ 还原`；一旦你手动改字，还原按钮自动撤回，绝不覆盖你的编辑 |
| **悬停预览**（v1.1.0，默认关闭） | 鼠标停在按钮上 250ms，输入框上方浮出润色结果与消耗；看不上就移开，草稿一字未动 |
| **右击设置菜单**（v1.1.0，默认关闭入口） | 右击按钮弹出 iOS 风菜单：开关预览、开关消耗预估、设长草稿上限、立即重新生成、使用说明 |
| **Token 预估** | 输入时右下角实时显示 `预估本次润色 ≈ N tokens`（含 system prompt 固定开销） |
| **Token 实际值** | 完成后同一位置替换为 `本次润色实际消耗 N tokens（输入 x / 输出 y）` |
| **低存在感样式** | 灰色小字、`pointer-events: none`，只提示不抢注意力 |
| **主题自适应** | 全部使用 `--dsw-alias-*` 主题 token，亮/暗色自动生效 |
| **完整可撤销** | 所有槽位注册、handler、状态都归当前 Fiber，停止/更新即清理 |

### v1.1.0 的五个成本闸门

悬停预览是**唯一会因"用户没做什么"而产生费用的入口**，所以它被五道闸门夹住：

1. **触发是 `mouseenter`**（进入那一刻一次）——鼠标停着不动不产生任何事件，挂机不会累积
2. **re-entry gate**——每次"进入"最多自动生成一次；鼠标一直停着时，即使草稿被 DSH/助手改写也**不会**重新生成
3. **指纹缓存**——同草稿反复悬停直接显示缓存，**0 token**
4. **在飞去重**——同一草稿请求未返回时不再叠加
5. **长草稿闸门**——超过上限（默认 2000 字，可调）只显示「点此生成预览」，要花这笔钱必须亲手点

> 装上 v1.1.0 后**行为与 v1.0.0 完全一致**（预览默认关闭），直到你右击按钮自己打开。


---

## 安装

有两种形态，任选其一。两者的 UI、润色策略、token 统计完全一致，只是 Client→Host 的通信通道不同。

### A. 持久化安装（推荐，随 DSH 启动自动挂载）

> **先看 [`INSTALL.md`](INSTALL.md)（自包含安装手册）。**
> 安装只需要 3 条命令；手册里冻结了全部 API 契约，**不要为了安装去打开 DSH 源码**——
> 那是整个流程里唯一的大额 token 开销（详见文末「安装的 token 成本」）。

```powershell
pwsh -NoProfile -File .\install.ps1
```

脚本把 [`plugin/`](plugin/) 复制到 `$DSH_HOME\plugins\dsh-plugin-ai-polish`，再执行
`dsh plugin --profile web add "link:<该目录>"`（这一步同时把插件写进 profile 的
`dsh.profile.bundles`）。装完**重启 DSH**（Host 半）并刷新页面（Client 半）即可看到按钮。

验证：

```powershell
dsh --profile web --dump-config | Select-String 'ai-polish'   # 组合树里应出现该行
curl.exe http://127.0.0.1:3080/dsh-ai-polish/status           # 应返回当前模型路由
```

卸载：`dsh plugin --profile web remove dsh-plugin-ai-polish`。
细节与 HTTP 契约见 [`plugin/README.md`](plugin/README.md)。

### B. 动态插件（随进程存活，停止即完全撤销）

本插件也可以「两个 JS 函数体」的形式直接装载，无需安装任何包。
前提是当前会话**确实具备** `cordis_define` / `cordis_run` 工具（在会话工具列表里查得到）；
若没有，请走上面的 A 方案。

**1. 让 DSH 会话具备 Cordis 工具**（本会话已具备可跳过）

**2. 定义插件** —— 复制本仓库两个文件，分别粘贴进 `cordis_define`：

| 参数 | 值 |
| --- | --- |
| `plugin` | `{"kind": "new", "idPrefix": "aipol"}` |
| `name` | `AI 润色` |
| `purpose` | 在模型选择器左侧添加 AI 润色按钮，并在输入框右下角显示 token 消耗 |
| `code.host` | [`src/host.js`](src/host.js) 全文 |
| `code.client` | [`src/client.js`](src/client.js) 全文 |

> 两个文件都是**纯 JavaScript 函数体**（`return { apply(ctx) { ... } }`），不是模块：没有 `import` / `require` / TS / JSX，直接作为字符串传入即可。

**3. 激活** —— 调用 `cordis_run`（首次用 `mode: "run"`），然后在会话里的运行卡片上点「允许」。带浏览器半的包需要人工批准才会挂载 UI。

> `idPrefix` 是 3–6 位小写英文字母，Host 会自动补数字后缀（例如实际得到 `aipol-2`），所以每次装载的 `pluginId` 可能不同，以返回值和你自己的 `@pluginId` 为准。

---

## 工作原理

Host 与 Client 各司其职，通过 **Package 私有 JSON-RPC** 通信（`harness.handle` ⇄ `host.call`），不注册公开服务、不引入持久化。

```
┌─────────────────────────── Client（浏览器） ───────────────────────────┐
│  conversation.input.right  →  ✨ AI 润色 按钮 + ↺ 还原                 │
│  conversation.composer.dock →  右下角 Token 统计（预估 / 实际 / 失败）  │
│  读取 InputState.draft（useInput），写回 InputActions.setDraft()        │
│  本地启发式估算 token（CJK ≈1.5/字，ASCII ≈0.3/字符）                   │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  host.call('polish', { text })
                                ▼
┌─────────────────────────── Host（DSH 进程） ──────────────────────────┐
│  从 agentDefaultModel.currentSelection() 取当前 provider + model        │
│  ctx.llm.stream({ provider, model, system, messages, temperature })    │
│  只累加 type === 'text-delta'（排除 reasoning-delta）                   │
│  读 type === 'usage' / 'finish'，归一化为 { inputTokens, outputTokens,  │
│  totalTokens, cacheReadTokens } 后回传                                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 润色策略

system prompt 的核心约束（见 [`src/host.js`](src/host.js)）：

- **保留原意**：绝不添加草稿中没有的事实、观点或承诺
- **同语言**：中文进中文出，英文进英文出
- **清理**：去掉口头禅、犹豫、重复、语病，修标点
- **重组**：让意图读起来完整、有逻辑
- **只输出正文**：不要解释、标题、markdown、引号、代码块

---

## 依赖的真实契约

本插件的实现**逐条对照 DSH 源码**核验，不是靠猜 API 名字。若你的 DSH 版本不同，请以下面这些契约为准重新核对：

| 契约 | 关键点 |
| --- | --- |
| `GenerateOptions` | **`provider` 与 `model` 都是必填**；一次性调用用 `system` 承载指令 |
| `Message` | 适配器只读 `role` 与 `content`；`content: [{ type: 'text', text }]` |
| `StreamChunk` | `text-delta { text }` / `usage { usage }` / `finish { reason }`；`reason.kind ∈ stop｜tool-calls｜max-tokens｜aborted｜error` |
| `TokenUsage` | `inputTokens` **仅含未命中缓存的输入**，计费输入需叠加 `cacheReadTokens` / `cacheWriteTokens` |
| `agentDefaultModel.currentSelection()` | 返回 `{ provider, model, reasoningEffort? }`；会话内切换模型会写回该服务，因此它反映用户当前所选模型 |
| 槽位 `conversation.input.right` | session 作用域 `list`，`{ name, id, order?, label? }`；渲染在 `conversation.input.model` **之前** |
| 槽位 `conversation.composer.dock` | session 作用域 `list`，官方 `stats` 也在其中，本插件用独立 `id` 并存 |
| 标准 props | `useInput(selector)`（`SnapshotSelectorHook<InputState>`）与 `inputActions: InputActions` |
| `InputActions.setDraft(text)` | 整体替换草稿 |
| Builtin `host` | Client→Host 的 `host.call()` 是**平台内置全局**，不是 Service，不能用 `ctx.get('host')` |

### 三个容易踩的坑

1. **别用 `conversation.input.left`** —— 那在工具行最左端；要贴在模型选择器左边必须用 `conversation.input.right`。
2. **别从 `chunk.text` 收集正文** —— `reasoning-delta` 也有 `text` 字段，会把思维链拼进结果；必须判断 `chunk.type === 'text-delta'`。
3. **`provider` 不能省** —— 只传 `model` 会被适配器拒绝；要从 `agentDefaultModel` 取回 provider。

---

## 已知限制

- **动态插件不持久**：DSH 进程重启后插件消失，需要重新 `cordis_define` + `cordis_run`。这是 Cordis 动态插件的设计，不是 bug。
- **预估是启发式**：右下角预估值由字符分布估算，用于量级感知；真实计费以「实际消耗」为准。推理模型的 `outputTokens` 会明显大于可见正文长度（思考 token 计在内），这是真实计费口径。
- **模型来源**：默认复用 `agentDefaultModel.currentSelection()`，即用户在界面上选中的模型；若该服务不可用则报「无法确定当前会话使用的模型」。
- **与官方 stats 并存**：`conversation.composer.dock` 里 DSH 自带 `stats` 药丸，本插件是它下方的独立一行。
- **草稿上限 12000 字符**，超出会提示分段润色（避免误粘贴触发超长请求）。

---

## 安装的 token 成本（实测，2026-10-06）

安装动作本身**不花模型 token**：`install.ps1` 只做文件复制 + `dsh plugin add`（本地命令），
`status` 自检是本地 HTTP，均不调用模型。

真正的开销来自**助手为了核对 API 去通读 DSH 安装包源码**。那次安装的实测账：

| 项目 | 实测值 |
| --- | --- |
| 单次最贵调用 | **18,567** 新增输入 token（读 `cordis-plugin-development/SKILL.md` + 模板） |
| 该次占全会话新增输入 | 6% |
| 整次安装（含 API 核对）新增输入 | **约 11 万** token |
| 插件**运行**成本 | 点一次「✨ AI 润色」≈ **393** tokens（≈ 2 厘） |
| 插件**空转**成本 | **0**（20 秒空闲会话日志一字节未增长，无后台模型调用） |

**降本措施（已落地）**

1. [`INSTALL.md`](INSTALL.md)：自包含手册，3 条命令 + 故障速查 + **冻结的 API 契约表**。照它装，无需读任何源码。
2. `README` 与 `plugin/README.md` 顶部都指向该手册，并写明「不要读 `node_modules/@deepseek-ai/**`」。
3. 明确禁止为「验证」而做真实润色调用：空草稿分支（`{"text":"   "}` → 报错文案）足以证明路由与模型解析可用。

**给后续会话的硬性约束**：装/改本插件时，若怀疑某条契约失效，**只准用 `grep` 精确查那一条符号**
（如 `currentSelection`、`stream(`），不准整文件通读 `dsh-client-ui-conversation/lib/client.js`
这类万行级文件。

---

## 仓库结构

```
.
├── plugin/          # 持久化 bundle：可被 dsh plugin 安装进 profile
│   ├── package.json      # dsh.bundle.patch + dsh.client 清单
│   ├── cordis.patch.yml  # 挂载声明
│   ├── index.js          # Host 半：HTTP 路由 + 模型调用 + usage 归一化
│   ├── client.js         # Client 半：润色按钮 + Token 统计
│   └── README.md         # 安装细节与 HTTP 契约
├── src/             # 动态插件形态：粘贴进 cordis_define 的函数体
│   ├── host.js           # code.host
│   └── client.js         # code.client
├── install.ps1      # 一键安装：复制到 $DSH_HOME\plugins + dsh plugin add
├── CHANGELOG.md     # 更新公告：新增/移除/优化/修复
├── INSTALL.md       # 自包含安装手册（3 条命令 + 冻结的 API 契约表）
├── .gitignore
├── LICENSE
└── README.md
```

---

## English

A Cordis dynamic plugin for DeepSeek Harness that adds an **AI Polish** button immediately left of the model selector in the composer. It rewrites a hesitant draft into clear, formal, professional prose in the same language, keeps the original for one-click restore, and shows an estimated / actual token cost in small grey text at the bottom-right of the input box.

Load it by pasting `src/host.js` and `src/client.js` into `cordis_define` (`{"kind":"new","idPrefix":"aipol"}`) and then calling `cordis_run`. It is process-local: stopping the plugin removes every UI entry, handler, and state it added.

A persistent, installable form of the same plugin lives in [`plugin/`](plugin/): run `pwsh -NoProfile -File .\install.ps1`, which copies the bundle to `$DSH_HOME\plugins\dsh-plugin-ai-polish` and installs it into the profile with `dsh plugin --profile web add "link:<dir>"`. The two halves are identical in behavior; only the Client→Host channel differs (HTTP route via `ctx.webServer` + `fetch` instead of the package-private JSON-RPC `harness.handle` / `host.call`).

---

## License

[MIT](LICENSE)
