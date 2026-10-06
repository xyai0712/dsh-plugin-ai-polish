// ============================================================================
// AI 润色插件 · Host 半（Cordis 动态插件的 code.host 函数体）
//
// 职责
//   1. 通过 harness.handle('polish', ...) 暴露一个 Package 私有的 Client→Host 方法
//   2. 解析当前模型路由（provider + model），复用会话已选模型
//   3. 调用 ctx.llm.stream() 做一次一次性模型请求，把草稿润色为专业正式表达
//   4. 归一化 TokenUsage，回传 { ok, text, usage }
//
// 已核实的真实契约
//   - GenerateOptions: { provider, model, messages, system?, temperature?, maxTokens? }
//     provider 与 model 均为必填；system 供一次性调用者使用
//   - messages: Message[]，适配器只读取 message.role 与 message.content
//     content 为 ContentBlock[]，文本块形如 { type: 'text', text }
//   - StreamChunk: text-delta { text } / usage { usage } / finish { reason }
//     finish.reason.kind ∈ stop | tool-calls | max-tokens | aborted | error
//   - TokenUsage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens? }
//     inputTokens 仅含未命中缓存的输入，故计费输入需叠加缓存字段
//   - agentDefaultModel.currentSelection(): { provider, model, reasoningEffort? }
//     会话内切换模型会经 session-controller 写回该服务，因此它反映用户当前所选模型
// ============================================================================

/** 润色指令：同语言输出、保留原意、专业正式、只输出正文。 */
const POLISH_SYSTEM_PROMPT = [
  'You are a professional text polisher.',
  "Rewrite the user's draft into clear, formal, and professional prose.",
  'Preserve the original meaning exactly: never add facts, opinions, or promises the draft does not contain.',
  'Keep the same language as the input (Chinese stays Chinese, English stays English, and so on).',
  'Remove filler words, hesitations, repetitions, and grammatical errors; repair punctuation.',
  'Reorganize the sentences so the intent reads completely and logically.',
  'Output ONLY the polished text. No explanations, no headings, no markdown, no quotation marks, no code fences.',
].join('\n')

/** 草稿长度上限，避免一次误粘贴触发超长请求。 */
const MAX_DRAFT_CHARS = 12000

/** 兜底估算：CJK 约 1.5 token/字，其余约 0.3 token/字符。 */
function estimateTextTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) count += 1.5
    else if (code >= 0x3000 && code <= 0x303f) count += 1
    else if (code >= 0xff00 && code <= 0xffef) count += 0.8
    else count += 0.3
  }
  return Math.max(1, Math.round(count))
}

/** 把任意抛出物归一为可读文案。 */
function describeError(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 只挑出标量字段，避免把任何实时对象带过 RPC 边界。 */
function normalizeUsage(usage, text) {
  let inputTokens = null
  let outputTokens = null
  let totalTokens = null
  let cacheReadTokens = null

  if (usage !== null && typeof usage === 'object') {
    if (typeof usage.inputTokens === 'number') inputTokens = usage.inputTokens
    if (typeof usage.outputTokens === 'number') outputTokens = usage.outputTokens
    if (typeof usage.totalTokens === 'number') totalTokens = usage.totalTokens
    if (typeof usage.cacheReadTokens === 'number') cacheReadTokens = usage.cacheReadTokens
  }

  if (totalTokens === null) {
    const parts = [inputTokens, outputTokens, cacheReadTokens].filter(function (v) { return typeof v === 'number' })
    if (parts.length > 0) {
      totalTokens = parts.reduce(function (a, b) { return a + b }, 0)
    }
  }

  // 模型未回传用量时，用本地估算保证界面仍有数字可显示。
  if (totalTokens === null) {
    const fallback = estimateTextTokens(text)
    outputTokens = fallback
    totalTokens = fallback
  }

  return {
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    totalTokens: totalTokens,
    cacheReadTokens: cacheReadTokens,
  }
}

return {
  apply(ctx) {
    const harness = ctx.get('harness')
    if (harness === undefined || harness === null || typeof harness.handle !== 'function') return

    const llm = ctx.get('llm')
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const tokenMeter = ctx.get('tokenMeter')

    /** 解析本次调用使用的 provider/model：显式入参优先，否则复用会话当前所选模型。 */
    function resolveRoute(args) {
      const provider = args && typeof args.provider === 'string' && args.provider !== '' ? args.provider : null
      const model = args && typeof args.model === 'string' && args.model !== '' ? args.model : null
      if (provider !== null && model !== null) return { provider: provider, model: model }

      if (agentDefaultModel !== null && agentDefaultModel !== undefined
        && typeof agentDefaultModel.currentSelection === 'function') {
        try {
          const selection = agentDefaultModel.currentSelection()
          if (selection !== null && selection !== undefined
            && typeof selection.provider === 'string' && typeof selection.model === 'string') {
            return {
              provider: selection.provider,
              model: selection.model,
              reasoningEffort: selection.reasoningEffort,
            }
          }
        } catch (error) {
          console.error('ai-polish: 读取当前模型失败', describeError(error))
        }
      }
      return null
    }

    /** 一次完整的润色调用。 */
    async function polish(args) {
      const draft = args !== null && typeof args === 'object' && typeof args.text === 'string'
        ? args.text.trim()
        : ''

      if (draft === '') return { ok: false, error: '请先输入需要润色的内容' }
      if (draft.length > MAX_DRAFT_CHARS) {
        return { ok: false, error: '草稿过长（超过 ' + MAX_DRAFT_CHARS + ' 字符），请分段润色' }
      }
      if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
        return { ok: false, error: '模型服务不可用' }
      }

      const route = resolveRoute(args)
      if (route === null) return { ok: false, error: '无法确定当前会话使用的模型' }

      // 一次性调用：system 承载指令，messages 只放草稿本身。
      const options = {
        provider: route.provider,
        model: route.model,
        system: POLISH_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: [{ type: 'text', text: draft }] },
        ],
        temperature: 0.2,
        maxTokens: 2048,
      }
      if (route.reasoningEffort !== undefined && route.reasoningEffort !== null) {
        options.reasoningEffort = route.reasoningEffort
      }

      let text = ''
      let usage = null
      let failure = null

      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk === null || typeof chunk !== 'object') continue

          // 只收可见正文，显式排除 reasoning-delta。
          if (chunk.type === 'text-delta') {
            if (typeof chunk.text === 'string') text += chunk.text
            continue
          }
          if (chunk.type === 'usage') {
            if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage
            continue
          }
          if (chunk.type === 'finish') {
            const reason = chunk.reason
            if (reason !== null && reason !== undefined) {
              if (reason.kind === 'error' || reason.kind === 'aborted') {
                failure = (reason.failure && typeof reason.failure.message === 'string')
                  ? reason.failure.message
                  : '模型调用被中断'
              } else if (reason.kind === 'max-tokens') {
                failure = '润色结果达到长度上限，请缩短草稿后重试'
              }
            }
          }
        }
      } catch (error) {
        return { ok: false, error: describeError(error) }
      }

      if (failure !== null) return { ok: false, error: failure }

      const polished = text.trim()
      if (polished === '') return { ok: false, error: '润色结果为空，请重试' }

      let normalized = normalizeUsage(usage, polished)

      // 用量缺失时，尝试用官方估算器补一个更准的输出计数。
      if (usage === null && tokenMeter !== null && tokenMeter !== undefined
        && typeof tokenMeter.estimateMessage === 'function') {
        try {
          const estimated = tokenMeter.estimateMessage({
            role: 'assistant',
            content: [{ type: 'text', text: polished }],
          })
          if (typeof estimated === 'number' && estimated > 0) {
            const inputEstimate = estimateTextTokens(draft)
            normalized = {
              inputTokens: inputEstimate,
              outputTokens: estimated,
              totalTokens: inputEstimate + estimated,
              cacheReadTokens: null,
            }
          }
        } catch (error) {
          // 估算失败不影响主流程：沿用本地兜底数值。
        }
      }

      return {
        ok: true,
        text: polished,
        usage: normalized,
        provider: route.provider,
        model: route.model,
      }
    }

    // handler 的生命周期随本 Package 的 Fiber：停止/更新/移除时自动撤销。
    ctx.effect(function () {
      return harness.handle('polish', async function (args) {
        try {
          return await polish(args)
        } catch (error) {
          return { ok: false, error: describeError(error) }
        }
      })
    }, 'ai-polish: polish handler')
  },
}
