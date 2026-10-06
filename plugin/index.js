// ============================================================================
// AI 润色插件 · Host 半（持久化 bundle 的 index.js）
//
// 与动态版（仓库 src/host.js）的区别只在"通信通道"：
//   动态版  Client→Host 走 Package 私有 JSON-RPC（harness.handle / host.call）
//   持久版  Client→Host 走本插件自注册的 HTTP 路由（webServer.register / fetch）
//
// 已核实的真实契约（全部对照本机 DSH 安装包的 .d.ts / 已装插件核验）
//   - Cordis 插件导出：export function apply(ctx, config) 与 export const inject
//   - ctx.webServer.register({ kind, path, handler }) → 返回 disposer
//     · 多条路由 path 必须唯一，且不能以 '/' 结尾
//     · handler(req, res) 自行负责响应生命周期
//   - ctx.llm.stream(options): AsyncIterable<StreamChunk>
//     · GenerateOptions: { provider, model, system?, messages, temperature?, maxTokens?, signal? }
//     · provider 与 model 均为必填
//   - ctx.agentDefaultModel.currentSelection(): { provider, model, reasoningEffort? }
//     · 会话内切换模型会写回该服务，因此它反映用户当前所选模型
//   - StreamChunk: text-delta { text } / usage { usage } / finish { reason }
//     · finish.reason.kind ∈ stop | tool-calls | max-tokens | aborted | error
//   - TokenUsage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens? }
//     · inputTokens 仅含未命中缓存的输入
//   - ctx.tokenMeter.estimateMessage(message): number
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

/** 请求体上限（含 JSON 包装），超出直接拒绝。 */
const MAX_BODY_BYTES = 65536

/** 单次润色的墙钟上限（毫秒）：客户端断开也靠这个兜底收尾。 */
const CALL_TIMEOUT_MS = 120000

/** 本插件注册的两条路由。 */
const ROUTE_POLISH = '/dsh-ai-polish/polish'
const ROUTE_STATUS = '/dsh-ai-polish/status'

/** Cordis 注入：缺任何一个，apply 都不会被调用。 */
export const inject = ['llm', 'agentDefaultModel', 'tokenMeter', 'webServer']

/** 本插件的 Loader id（与 cordis.patch.yml 中一致）。 */
export const name = 'dsh-plugin-ai-polish'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

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

/** 只挑出标量字段，避免把任何实时对象带出进程边界。 */
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
    const parts = [inputTokens, outputTokens, cacheReadTokens].filter(function (value) {
      return typeof value === 'number'
    })
    if (parts.length > 0) totalTokens = parts.reduce(function (a, b) { return a + b }, 0)
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

/** 读取请求体，超过上限即中断连接。 */
function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    req.on('data', function (chunk) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** 统一 JSON 响应。 */
function respond(res, status, payload) {
  try {
    if (res.writableEnded) return
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  } catch (error) {
    // 客户端提前断开时 res 可能已不可写：不影响插件本身。
  }
}

/** 构造一次请求用的 AbortSignal：超时或客户端断开都终止。 */
function callSignal(req) {
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, CALL_TIMEOUT_MS)
  const onClose = function () { controller.abort() }
  req.on('close', onClose)
  return {
    signal: controller.signal,
    dispose: function () {
      clearTimeout(timer)
      req.off('close', onClose)
    },
  }
}

export function apply(ctx) {
  /**
   * 一次完整的润色调用。
   * @param draftInput 用户草稿
   * @param signal 中止信号
   * @returns 与客户端约定的结果对象
   */
  async function polish(draftInput, signal) {
    const draft = typeof draftInput === 'string' ? draftInput.trim() : ''
    if (draft === '') return { ok: false, error: '请先输入需要润色的内容' }
    if (draft.length > MAX_DRAFT_CHARS) {
      return { ok: false, error: '草稿过长（超过 ' + MAX_DRAFT_CHARS + ' 字符），请分段润色' }
    }

    // 复用会话当前所选模型；解析失败即明确报错，不静默换模型。
    let route = null
    try {
      const selection = ctx.agentDefaultModel.currentSelection()
      if (selection !== null && selection !== undefined
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        route = {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        }
      }
    } catch (error) {
      console.error('ai-polish: 读取当前模型失败', describeError(error))
    }
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
      signal: signal,
    }
    if (route.reasoningEffort !== undefined && route.reasoningEffort !== null) {
      options.reasoningEffort = route.reasoningEffort
    }

    let text = ''
    let usage = null
    let failure = null

    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue

        // 只收可见正文，显式排除 reasoning-delta（它同样带 text 字段）。
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
    if (usage === null && ctx.tokenMeter !== undefined && ctx.tokenMeter !== null
      && typeof ctx.tokenMeter.estimateMessage === 'function') {
      try {
        const estimated = ctx.tokenMeter.estimateMessage({
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

  // 路由注册归当前 Fiber：插件停止/重载时自动撤销。
  ctx.effect(function () {
    const disposePolish = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_POLISH,
      handler: async function (req, res) {
        if (req.method !== 'POST') {
          respond(res, 405, { ok: false, error: '请使用 POST' })
          return
        }
        let payload = null
        try {
          const raw = await readBody(req)
          payload = raw === '' ? {} : JSON.parse(raw)
        } catch (error) {
          respond(res, 400, { ok: false, error: '请求体不是合法 JSON：' + describeError(error) })
          return
        }

        const call = callSignal(req)
        try {
          const result = await polish(payload ? payload.text : '', call.signal)
          respond(res, 200, result)
        } catch (error) {
          respond(res, 200, { ok: false, error: describeError(error) })
        } finally {
          call.dispose()
        }
      },
    })

    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_STATUS,
      handler: function (req, res) {
        let route = null
        try {
          const selection = ctx.agentDefaultModel.currentSelection()
          if (selection !== null && selection !== undefined) {
            route = { provider: selection.provider, model: selection.model }
          }
        } catch (error) {
          route = null
        }
        respond(res, 200, {
          ok: true,
          plugin: 'dsh-plugin-ai-polish',
          maxDraftChars: MAX_DRAFT_CHARS,
          route: route,
        })
      },
    })

    return function () {
      if (typeof disposePolish === 'function') disposePolish()
      if (typeof disposeStatus === 'function') disposeStatus()
    }
  }, 'ai-polish: http routes')
}
