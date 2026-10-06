// ============================================================================
// AI 润色插件 · Client 半（持久化 bundle 的 client.js）
//
// 手写的 lazy-CJS 浏览器 bundle：window.__ModuleLoader__.load 注册一个
// factory，模块体只在首次物化时执行。React 来自平台模块表（require('react')），
// 不引入任何 dsh 客户端包。
//
// 与动态版（仓库 src/client.js）的区别只在"通信通道"：
//   动态版   host.call('polish', { text })         ← Package 私有 JSON-RPC
//   持久版   fetch('/dsh-ai-polish/polish', POST)  ← 本插件 Host 半的 HTTP 路由
//
// 已核实的真实契约
//   - 两个槽位都是 session 作用域 list：conversation.input.right / conversation.composer.dock
//     · 注册项 { name, id, order?, label? }
//     · register(..., Component) 返回 disposer；inject(name, callback) 返回 disposer
//   - 两个槽位的标准 props 均含 useInput: SnapshotSelectorHook<InputState> 与 inputActions: InputActions
//     · useInput(selector, eq?) 必须传入选择器
//     · InputState: { draft, attachmentIds, draftRev, phase, ... }
//       phase ∈ 'plain' | 'adjudicating' | 'claimed' | 'submitting'
//     · InputActions.setDraft(text) 整体替换草稿
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ai-polish',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    /** useInput 缺席时的稳定兜底快照，保证 Hook 调用顺序恒定。 */
    const EMPTY_INPUT_STATE = { draft: '', phase: 'plain' }

    /** 与本插件 Host 半 system prompt 规模相当的固定开销，用于让预估值贴近真实请求。 */
    const SYSTEM_PROMPT_TOKENS = 130

    /** 与 Host 半一致的长度上限。 */
    const MAX_DRAFT_CHARS = 12000

    /** Host 半注册的润色路由。 */
    const POLISH_URL = '/dsh-ai-polish/polish'

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

    /** 稳定兜底 Hook：不订阅任何源，只回放空快照。 */
    function useEmptyInput(selector) {
      return selector(EMPTY_INPUT_STATE)
    }

    /** 选取草稿文本。 */
    function selectDraft(state) {
      return state && typeof state.draft === 'string' ? state.draft : ''
    }

    /** 选取输入阶段。 */
    function selectPhase(state) {
      return state && typeof state.phase === 'string' ? state.phase : 'plain'
    }

    /** 把归一化后的用量拼成一行灰色小字。 */
    function formatUsage(usage) {
      if (usage === null || usage === undefined || typeof usage !== 'object') return null
      const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : null
      const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : null
      const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : null

      if (total !== null) {
        let line = '本次润色实际消耗 ' + total + ' tokens'
        if (input !== null && output !== null) line += '（输入 ' + input + ' / 输出 ' + output + '）'
        return line
      }
      if (output !== null) return '本次润色实际输出 ' + output + ' tokens'
      return '润色完成'
    }

    /** 调用 Host 半的 HTTP 路由。 */
    function callPolish(text) {
      return fetch(POLISH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      }).then(function (response) {
        return response.json().catch(function () {
          return { ok: false, error: '润色服务返回了非 JSON 响应（HTTP ' + response.status + '）' }
        })
      }).then(function (result) {
        if (result === null || result === undefined || result.ok !== true) {
          const message = result && typeof result.error === 'string' && result.error !== ''
            ? result.error
            : '润色失败'
          throw new Error(message)
        }
        return result
      })
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') return

      // ------------------------------------------------------------------
      // 跨两个槽位共享的润色状态（普通对象 + 订阅通知，避免依赖未文档化的 Hook）
      // ------------------------------------------------------------------
      const store = {
        status: 'idle', // 'idle' | 'loading' | 'done' | 'error'
        error: '',
        usage: null,
        original: null, // 润色前的原始草稿；非 null 时可还原
        polished: null, // 最近一次的润色结果，用于判断用户是否已手动改动
        listeners: new Set(),
      }

      function notify() {
        for (const listener of Array.from(store.listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('ai-polish: 状态通知失败', error)
          }
        }
      }

      /** 订阅共享状态；返回的对象每次渲染都是最新的 store 引用。 */
      function usePolishStore() {
        const state = React.useState(0)
        const setTick = state[1]
        React.useEffect(function () {
          function listener() {
            setTick(function (tick) { return tick + 1 })
          }
          store.listeners.add(listener)
          return function () {
            store.listeners.delete(listener)
          }
        }, [])
        return store
      }

      /** 读取 Composer 输入状态：始终调用两个 Hook，保持顺序稳定。 */
      function useComposerInput(props) {
        const useInput = (props !== null && props !== undefined && typeof props.useInput === 'function')
          ? props.useInput
          : useEmptyInput
        const draft = useInput(selectDraft)
        const phase = useInput(selectPhase)
        return {
          draft: typeof draft === 'string' ? draft : '',
          phase: typeof phase === 'string' ? phase : 'plain',
        }
      }

      // 主题 token（均由主题系统提供，亮/暗两套自动生效）
      const COLOR_TEXT = 'var(--dsw-alias-label-primary)'
      const COLOR_MUTED = 'var(--dsw-alias-label-secondary)'
      const COLOR_BORDER = 'var(--dsw-alias-border-l1)'
      const COLOR_ERROR = 'var(--dsw-alias-state-error-primary)'
      const COLOR_HOVER_BG = 'var(--dsw-alias-bg-layer-2)'

      // ------------------------------------------------------------------
      // 槽位一：模型选择器左侧的「AI 润色」按钮
      // ------------------------------------------------------------------
      function PolishButton(props) {
        const state = usePolishStore()
        const input = useComposerInput(props)
        const draft = input.draft

        const actions = (props !== null && props !== undefined) ? props.inputActions : null
        const canWrite = actions !== null && actions !== undefined && typeof actions.setDraft === 'function'

        const busy = state.status === 'loading'
        const hasText = draft.trim() !== ''
        const disabled = !hasText || busy || input.phase !== 'plain' || !canWrite
        const showRestore = state.polished !== null && state.original !== null && draft === state.polished

        // 用户手动改动草稿后，撤回还原态，避免「还原」把编辑覆盖掉。
        React.useEffect(function () {
          if (state.polished !== null && draft !== state.polished) {
            state.polished = null
            state.original = null
            state.usage = null
            if (state.status !== 'loading') {
              state.status = 'idle'
              state.error = ''
            }
            notify()
          }
        }, [draft])

        function handlePolish() {
          if (disabled) return
          const source = draft.trim()
          if (source.length > MAX_DRAFT_CHARS) {
            state.status = 'error'
            state.error = '草稿过长，请分段润色'
            notify()
            return
          }

          state.status = 'loading'
          state.error = ''
          state.usage = null
          state.original = source
          state.polished = null
          notify()

          callPolish(source).then(function (result) {
            state.polished = result.text
            state.usage = result.usage || null
            state.status = 'done'
            actions.setDraft(result.text)
          }).catch(function (error) {
            state.status = 'error'
            state.error = (error && typeof error.message === 'string' && error.message !== '')
              ? error.message
              : '调用润色服务失败'
          }).then(function () {
            notify()
          })
        }

        function handleRestore() {
          if (!canWrite || state.original === null) return
          actions.setDraft(state.original)
          state.status = 'idle'
          state.error = ''
          state.usage = null
          state.polished = null
          state.original = null
          notify()
        }

        const buttonStyle = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '24px',
          padding: '0 10px',
          borderRadius: '999px',
          border: '1px solid ' + COLOR_BORDER,
          background: 'transparent',
          color: disabled ? COLOR_MUTED : COLOR_TEXT,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '12px',
          lineHeight: '1',
          fontFamily: 'inherit',
          opacity: disabled ? 0.45 : 1,
          transition: 'background-color .15s ease, opacity .15s ease',
          whiteSpace: 'nowrap',
          flex: 'none',
        }

        const restoreStyle = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          height: '24px',
          marginLeft: '6px',
          padding: '0 8px',
          borderRadius: '999px',
          border: '1px solid transparent',
          background: 'transparent',
          color: COLOR_MUTED,
          cursor: 'pointer',
          fontSize: '11px',
          lineHeight: '1',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          flex: 'none',
        }

        const mainButton = React.createElement(
          'button',
          {
            type: 'button',
            disabled: disabled,
            onClick: handlePolish,
            style: buttonStyle,
            title: hasText ? '把草稿润色为专业、正式、完整的表达' : '请先输入需要润色的内容',
            'aria-label': 'AI 润色',
            onMouseEnter: function (event) {
              if (!disabled) event.currentTarget.style.backgroundColor = COLOR_HOVER_BG
            },
            onMouseLeave: function (event) {
              event.currentTarget.style.backgroundColor = 'transparent'
            },
          },
          React.createElement('span', { style: { fontSize: '12px' } }, '✨'),
          React.createElement('span', null, busy ? '润色中…' : 'AI 润色'),
        )

        if (!showRestore) return mainButton

        return React.createElement(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', flex: 'none' } },
          mainButton,
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: handleRestore,
              style: restoreStyle,
              title: '还原为润色前的原始草稿',
              'aria-label': '还原原始草稿',
            },
            React.createElement('span', null, '↺'),
            React.createElement('span', null, '还原'),
          ),
        )
      }

      // ------------------------------------------------------------------
      // 槽位二：输入框右下角的 Token 统计
      // ------------------------------------------------------------------
      function TokenStats(props) {
        const state = usePolishStore()
        const input = useComposerInput(props)
        const draft = input.draft

        let content = null
        let color = COLOR_MUTED
        let title = '预估基于字符启发式估算，实际值以模型返回的用量为准'

        if (state.status === 'loading') {
          content = '润色中…'
        } else if (state.status === 'error') {
          content = '润色失败' + (state.error !== '' ? ' · ' + state.error : '')
          color = COLOR_ERROR
          title = state.error
        } else if (state.status === 'done') {
          content = formatUsage(state.usage) || '润色完成'
          title = '本次润色请求的实际 token 用量'
        } else if (draft.trim() !== '') {
          const estimate = estimateTextTokens(draft) + SYSTEM_PROMPT_TOKENS
          content = '预估本次润色 ≈ ' + estimate + ' tokens'
        }

        const style = {
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          minHeight: '18px',
          padding: '2px 14px 0',
          fontSize: '11px',
          lineHeight: '16px',
          color: color,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          userSelect: 'none',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }

        if (content === null) {
          return React.createElement('div', { style: style }, '\u00A0')
        }
        return React.createElement('div', { style: style, title: title }, content)
      }

      // ------------------------------------------------------------------
      // 注册两个槽位；disposer 归当前 Fiber，插件停止/重载时自动撤销
      // ------------------------------------------------------------------
      ctx.effect(function () {
        const disposeButton = slots.inject('conversation.input.right', function () {
          return slots.register(
            { name: 'conversation.input.right', id: 'ai-polish-button', order: 20, label: 'AI 润色' },
            PolishButton,
          )
        })

        const disposeStats = slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'ai-polish-tokens', order: 20, label: '润色 Token 统计' },
            TokenStats,
          )
        })

        return function () {
          if (typeof disposeButton === 'function') disposeButton()
          if (typeof disposeStats === 'function') disposeStats()
          store.listeners.clear()
        }
      }, 'ai-polish: composer UI')
    }

    exports.apply = apply
    // 只依赖 slots；inputActions / useInput 由槽位的标准 props 提供。
    exports.inject = ['slots']
    return exports
  },
})
