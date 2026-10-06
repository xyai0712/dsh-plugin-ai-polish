# dsh-plugin-ai-polish

> 给 DeepSeek Harness（DSH）会话输入框加一个 **AI 润色** 按钮：把「心里有想法、嘴上说不清」的草稿，一键变成专业、正式、完整的表达，并在输入框右下角实时显示 token 消耗。

这是一个 [Cordis](https://github.com/deepseek-ai) **动态插件**：不写盘、不改仓库、随当前 DSH 进程存活，停止即完全撤销（含 UI、状态与 Host handler）。

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
| **空输入保护** | 草稿为空 / 模型正在提交时按钮置灰不可点 |
| **原稿保留 + 还原** | 润色后旁边出现 `↺ 还原`；一旦你手动改字，还原按钮自动撤回，绝不覆盖你的编辑 |
| **Token 预估** | 输入时右下角实时显示 `预估本次润色 ≈ N tokens`（含 system prompt 固定开销） |
| **Token 实际值** | 完成后同一位置替换为 `本次润色实际消耗 N tokens（输入 x / 输出 y）` |
| **低存在感样式** | 灰色小字、`pointer-events: none`，只提示不抢注意力 |
| **主题自适应** | 全部使用 `--dsw-alias-*` 主题 token，亮/暗色自动生效 |
| **完整可撤销** | 所有槽位注册、handler、状态都归当前 Fiber，停止/更新即清理 |

---

## 安装

本插件以「两个 JS 函数体」的形式分发：`code.host` 与 `code.client`。装载只需三步。

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

## 仓库结构

```
.
├── src/
│   ├── host.js      # code.host 函数体：模型调用 + usage 归一化
│   └── client.js    # code.client 函数体：润色按钮 + Token 统计
├── .gitignore
├── LICENSE
└── README.md
```

---

## English

A Cordis dynamic plugin for DeepSeek Harness that adds an **AI Polish** button immediately left of the model selector in the composer. It rewrites a hesitant draft into clear, formal, professional prose in the same language, keeps the original for one-click restore, and shows an estimated / actual token cost in small grey text at the bottom-right of the input box.

Load it by pasting `src/host.js` and `src/client.js` into `cordis_define` (`{"kind":"new","idPrefix":"aipol"}`) and then calling `cordis_run`. It is process-local: stopping the plugin removes every UI entry, handler, and state it added.

---

## License

[MIT](LICENSE)
