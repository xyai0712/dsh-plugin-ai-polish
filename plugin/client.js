// ============================================================================
// AI 润色插件 · Client 半（持久化 bundle 的 client.js）  v1.1.0
//
// 手写的 lazy-CJS 浏览器 bundle：window.__ModuleLoader__.load 注册一个
// factory，模块体只在首次物化时执行。React 来自平台模块表（require('react')），
// 不引入任何 dsh 客户端包。
//
// 三个注册面
//   1. conversation.input.right    「✨ AI 润色」按钮 + 「↺ 还原」
//      · 悬停 → 上方浮出预览卡片（默认关闭，需右击菜单开启）
//      · 左键 → 采纳已有预览（0 成本），否则即时润色并替换
//      · 右击 → 弹出自定义设置菜单（挡掉浏览器原生右键菜单；默认关闭）
//   2. conversation.input.overlay  预览卡片 + 右击菜单（浮在输入卡片上方）
//   3. conversation.composer.dock  右下角 token 统计
//
// 成本闸门（防止"鼠标停在按钮上"被动烧 token）
//   · 悬停触发是 mouseenter（进入那一刻一次），不是每帧轮询
//   · re-entry gate：每次"进入"最多自动生成一次；草稿在悬停期间被改动不重新生成
//   · 结果按草稿指纹缓存：同草稿反复悬停 0 成本
//   · 同草稿在飞时去重；超过"自动预览上限"的长草稿不自动生成
//
// 已核实的真实契约
//   - 三个槽位都是 session 作用域 list：conversation.input.right /
//     conversation.input.overlay / conversation.composer.dock
//     · 注册项 { name, id, order?, label? }；register(..., Component) 返回 disposer
//     · inject(name, callback) 返回 disposer
//   - 三个槽位的标准 props 均含 useInput: SnapshotSelectorHook<InputState>
//     与 inputActions: InputActions
//     · useInput(selector, eq?)  必须传入选择器
//     · InputState: { draft, attachmentIds, draftRev, phase, ... }
//       phase ∈ 'plain' | 'adjudicating' | 'claimed' | 'submitting'
//     · InputActions.setDraft(text) 整体替换草稿
//   - 客户端没有"打开本地文件"服务（Client Service 目录里只有 Slots/Theme/Config 等），
//     所以"使用说明"在菜单内原地展开，不依赖任何外部能力。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ai-polish',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    const VERSION = '1.1.0'

    /** useInput 缺席时的稳定兜底快照，保证 Hook 调用顺序恒定。 */
    const EMPTY_INPUT_STATE = { draft: '', phase: 'plain' }

    /** 与本插件 Host 半 system prompt 规模相当的固定开销，用于让预估值贴近真实请求。 */
    const SYSTEM_PROMPT_TOKENS = 130

    /** 与 Host 半一致的长度上限。 */
    const MAX_DRAFT_CHARS = 12000

    /** Host 半注册的润色路由。 */
    const POLISH_URL = '/dsh-ai-polish/polish'

    /** 鼠标进入按钮后多久算"真的要预览"（扫过、路过不算）。 */
    const HOVER_DELAY_MS = 250

    /** 设置持久化键（客户端插件在本仓库的既有做法是 localStorage）。 */
    const PREFS_KEY = 'dsh-ai-polish:prefs:v1'

    const DEFAULT_PREFS = {
      hoverPreview: false, // 默认关闭：不主动花用户的钱
      showCost: true, // token 透明是插件卖点
      autoPreviewChars: 2000, // 超过此长度不自动生成预览
    }

    const CHAR_LIMIT_STEPS = [500, 1000, 2000, 0] // 0 = 不限制

    const COLOR_TEXT = 'var(--dsw-alias-label-primary)'
    const COLOR_MUTED = 'var(--dsw-alias-label-secondary)'
    const COLOR_CAPTION = 'var(--dsw-alias-label-caption)'
    const COLOR_BORDER = 'var(--dsw-alias-border-l1)'
    const COLOR_BORDER_STRONG = 'var(--dsw-alias-border-l2)'
    const COLOR_ERROR = 'var(--dsw-alias-state-error-primary)'
    const COLOR_BUSINESS = 'var(--dsw-alias-state-business-primary)'

    // ---------------------------------------------------------------------
    // 主题 token 的兼容取值（名与 fallback 都逐条核对过 DSH 主题包）
    //
    // 教训：CSS 变量的 fallback **只在变量未定义时才生效**。所以一旦写了
    // 不存在的 token 名（如曾用过的 --dsw-alias-bg-elevated），浅色 fallback
    // 会在**暗色主题**下也被采用，浮层就变成"浅色面板 + 深色字"。
    // 下面每个变量都取自 dsh-client-ui-theme 里真实存在的名字，fallback 写成
    // 中性值，避免"暗色下露出浅色"这种翻车。
    // ---------------------------------------------------------------------
    const FALLBACKS = [
      'rgba(28,28,30,.72)', // 浮层玻璃底
      '0 12px 32px rgba(0,0,0,.4)', // 面板阴影
      '#34C759', // 成功色（开关）
      'rgba(120,120,128,.32)', // 开关未选中底
      'rgba(120,120,128,.2)', // 悬停底色
    ]

    /** 依次取第一个可用的 token 名，配上同序号的中性 fallback（暗色安全）。 */
    function pick() {
      for (let i = 0; i < arguments.length && i < FALLBACKS.length; i++) {
        const candidate = arguments[i]
        if (typeof candidate === 'string' && candidate !== '') {
          return candidate + ', ' + FALLBACKS[i]
        }
      }
      return FALLBACKS[0]
    }

    const GLASS_BG = pick('var(--dsw-specific-menu)', 'var(--dsw-alias-bg-overlay)')
    const SOLID_BG = pick('var(--dsw-specific-input-major)', 'var(--dsw-alias-bg-overlay)')
    const PANEL_SHADOW = pick('var(--dsw-elevation-panel)', 'var(--dsw-elevation-soft)')
    const SUCCESS_COLOR = pick('var(--dsw-alias-state-success-primary)')
    const SWITCH_OFF_BG = pick('var(--dsw-alias-interactive-bg-hover-solid)', 'var(--dsw-alias-interactive-bg-hover)')
    const HOVER_BG = pick('var(--dsw-alias-interactive-bg-hover)')
    const IOS_SPRING = 'cubic-bezier(.34,1.56,.64,1)'



    /** 统一的动效曲线；尊重 prefers-reduced-motion。 */
    function motion(ms) {
      let reduced = false
      try {
        reduced = typeof window !== 'undefined' && window.matchMedia
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          : false
      } catch (error) {
        reduced = false
      }
      return 'all ' + (reduced ? 0 : ms) + 'ms ' + IOS_SPRING
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

    /** 稳定兜底 Hook：不订阅任何源，只回放空快照。 */
    function useEmptyInput(selector) {
      return selector(EMPTY_INPUT_STATE)
    }

    function selectDraft(state) {
      return state && typeof state.draft === 'string' ? state.draft : ''
    }

    function selectPhase(state) {
      return state && typeof state.phase === 'string' ? state.phase : 'plain'
    }

    /** 读取偏好；localStorage 不可用时回落到默认值。 */
    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return { ...DEFAULT_PREFS }
        const parsed = JSON.parse(raw)
        return {
          hoverPreview: parsed.hoverPreview === true,
          showCost: parsed.showCost !== false,
          autoPreviewChars: CHAR_LIMIT_STEPS.indexOf(parsed.autoPreviewChars) === -1
            ? DEFAULT_PREFS.autoPreviewChars
            : parsed.autoPreviewChars,
        }
      } catch (error) {
        return { ...DEFAULT_PREFS }
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch (error) {
        // 持久化失败不影响本次会话内的行为。
      }
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

    /** 调 Host 半的 HTTP 路由。 */
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
      // 共享状态：三个注册面都读它，写入后 notify() 重渲染
      // ------------------------------------------------------------------
      const store = {
        // 输入框内已采纳的结果（供「↺ 还原」）
        applied: null,
        original: null,
        // 预览态
        previewStatus: 'idle', // 'idle' | 'loading' | 'preview' | 'error' | 'gate'
        previewText: null,
        previewUsage: null,
        previewFingerprint: null,
        previewFromCache: false,
        previewLoading: false,
        previewError: '',
        // 交互态
        hovering: false,
        enterHandled: false,
        liveDraft: '',
        menuOpen: false,
        menuAt: { x: 0, y: 0 },
        hint: '',
        hintTimer: null,
        prefs: loadPrefs(),
        // 右下角统计
        status: 'idle',
        usage: null,
        error: '',
        listeners: new Set(),
      }

      function estimateFor(text) {
        return estimateTextTokens(text) + SYSTEM_PROMPT_TOKENS
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

      function setPrefs(patch) {
        store.prefs = { ...store.prefs, ...patch }
        savePrefs(store.prefs)
        notify()
      }

      /** 轻提示：显示在输入框上方，自动消失（不消耗 token）。 */
      function showHint(text) {
        store.hint = text
        if (store.hintTimer !== null) clearTimeout(store.hintTimer)
        store.hintTimer = setTimeout(function () {
          store.hintTimer = null
          store.hint = ''
          notify()
        }, 2200)
        notify()
      }

      /** 悬停生命周期开始：re-entry gate —— 每次进入只允许自动生成一次。 */
      function beginHover() {
        store.hovering = true
        store.enterHandled = false
        notify()
      }

      function endHover() {
        store.hovering = false
        notify()
      }

      /** 消费本次"进入"的自动生成机会；已消费则返回 false。 */
      function consumeEnter() {
        if (store.enterHandled === true) return false
        store.enterHandled = true
        return true
      }

      /** 真正发起一次润色：in-flight 去重 + 长草稿闸门 + 指纹缓存。 */
      function generate(draft, options) {
        const source = typeof draft === 'string' ? draft.trim() : ''
        const manual = options !== undefined && options !== null && options.manual === true
        if (source === '') return

        if (source.length > MAX_DRAFT_CHARS) {
          store.previewStatus = 'error'
          store.previewError = '草稿过长（超过 ' + MAX_DRAFT_CHARS + ' 字符），请分段润色'
          store.hovering = true
          notify()
          return
        }
        if (store.previewLoading === true) return // 同草稿在飞：不排队、不叠加

        // 命中缓存：0 成本直接显示
        if (store.previewFingerprint === source && store.previewStatus === 'preview'
          && typeof store.previewText === 'string') {
          store.previewFromCache = true
          store.hovering = true
          notify()
          return
        }

        if (!manual && store.prefs.autoPreviewChars > 0 && source.length > store.prefs.autoPreviewChars) {
          // 长草稿不自动生成：只提示，要花这次钱必须用户亲手点
          store.previewStatus = 'gate'
          store.previewText = null
          store.previewUsage = null
          store.previewFingerprint = source
          store.previewError = ''
          store.hovering = true
          notify()
          return
        }

        store.previewLoading = true
        store.previewStatus = 'loading'
        store.previewError = ''
        store.previewFromCache = false
        store.previewFingerprint = source
        notify()

        callPolish(source).then(function (result) {
          const fresh = store.previewFingerprint === source
          // 结果只在该草稿仍然是最新指纹时才上台；否则丢弃，避免显示错版本
          if (!fresh) return
          store.previewText = result.text
          store.previewUsage = result.usage || null
          store.previewStatus = 'preview'
          store.usage = result.usage || null
          store.status = 'done'
        }).catch(function (error) {
          store.previewStatus = 'error'
          store.previewError = (error && typeof error.message === 'string' && error.message !== '')
            ? error.message
            : '调用润色服务失败'
          store.status = 'error'
          store.error = store.previewError
        }).then(function () {
          store.previewLoading = false
          notify()
        })
      }

      /** 悬停 → 预览：命中缓存 0 成本，否则受 re-entry gate 约束发起一次。 */
      function requestPreview() {
        const source = typeof store.liveDraft === 'string' ? store.liveDraft.trim() : ''
        if (source === '') return
        if (consumeEnter() === false) return
        generate(source, { manual: false })
      }

      function closeMenu() {
        if (store.menuOpen !== true) return
        store.menuOpen = false
        notify()
      }

      function openMenu(x, y) {
        store.menuAt = { x: x, y: y }
        store.menuOpen = true
        notify()
      }

      /** 采纳预览：写入输入框，并记下原稿供还原。草稿被改动时绝不覆盖。 */
      function accept(inputActions, draftAtAccept) {
        if (store.previewStatus !== 'preview' || typeof store.previewText !== 'string') return
        if (typeof draftAtAccept === 'string'
          && draftAtAccept.trim() !== String(store.previewFingerprint)) {
          store.previewError = '草稿已改动，请重新生成'
          notify()
          return
        }
        if (inputActions === null || inputActions === undefined
          || typeof inputActions.setDraft !== 'function') return
        store.original = store.previewFingerprint
        store.applied = store.previewText
        store.status = 'done'
        store.error = ''
        inputActions.setDraft(store.previewText)
        store.previewStatus = 'idle'
        store.previewText = null
        store.previewUsage = null
        store.previewFingerprint = null
        store.previewFromCache = false
        store.hovering = false
        notify()
      }

      /** 还原为润色前的原始草稿。 */
      function revert(inputActions) {
        if (inputActions === null || inputActions === undefined
          || typeof inputActions.setDraft !== 'function') return
        if (store.original === null) return
        inputActions.setDraft(store.original)
        store.applied = null
        store.original = null
        store.status = 'idle'
        store.usage = null
        store.error = ''
        notify()
      }

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

      /** 读取 Composer 输入状态；同时把最新草稿写回 store，供事件回调读取。 */
      function useComposerInput(props) {
        const useInput = (props !== null && props !== undefined && typeof props.useInput === 'function')
          ? props.useInput
          : useEmptyInput
        const draft = useInput(selectDraft)
        const phase = useInput(selectPhase)
        const text = typeof draft === 'string' ? draft : ''
        store.liveDraft = text
        return {
          draft: text,
          phase: typeof phase === 'string' ? phase : 'plain',
        }
      }

      function actionsOf(props) {
        return (props !== null && props !== undefined) ? props.inputActions : null
      }

      // ------------------------------------------------------------------
      // iOS 风基础件
      // ------------------------------------------------------------------
      function IosSwitch(props) {
        const on = props.checked === true
        return React.createElement(
          'span',
          {
            role: 'switch',
            'aria-checked': on,
            'aria-label': props.label,
            style: {
              position: 'relative',
              flex: 'none',
              width: '46px',
              height: '28px',
              borderRadius: '999px',
              background: on ? SUCCESS_COLOR : SWITCH_OFF_BG,
              transition: motion(220),
              display: 'inline-block',
            },
          },
          React.createElement('span', {
            style: {
              position: 'absolute',
              top: '3px',
              left: on ? '21px' : '3px',
              width: '22px',
              height: '22px',
              borderRadius: '999px',
              background: '#fff',
              boxShadow: '0 1px 3px rgba(0,0,0,.28)',
              transition: motion(220),
            },
          }),
        )
      }

      const MENU_ITEMS = [
        { id: 'hoverPreview', kind: 'switch', label: '悬停显示预览' },
        { id: 'showCost', kind: 'switch', label: '显示消耗预估' },
        { id: 'autoPreviewChars', kind: 'cycle', label: '长草稿自动预览上限' },
        { id: 'regen', kind: 'action', label: '立即重新生成' },
        { id: 'help', kind: 'action', label: '使用说明' },
      ]

      const HELP_LINES = [
        '悬停按钮看润色预览，左键采纳，右键改设置。',
        '同草稿重复悬停不重复计费；草稿一改才重新生成。',
        '长草稿不自动预览，需手动点「立即重新生成」。',
      ]

      function charLimitLabel(value) {
        return value === 0 ? '不限制' : value + ' 字'
      }

      // ------------------------------------------------------------------
      // 右击设置菜单（浮层，挂在预览卡片的 fixed 层里）
      // ------------------------------------------------------------------
      function SettingsMenu() {
        const state = usePolishStore()
        const shownState = React.useState(false)
        const visible = shownState[0]
        const setVisible = shownState[1]
        const helpState = React.useState(false)
        const helpOpen = helpState[0]
        const setHelpOpen = helpState[1]
        const indexRef = React.useRef(-1)
        const menuRef = React.useRef(null)

        React.useEffect(function () {
          const frame = requestAnimationFrame(function () { setVisible(true) })
          return function () { cancelAnimationFrame(frame) }
        }, [])

        React.useEffect(function () {
          function onPointerDown(event) {
            const node = menuRef.current
            if (node !== null && node.contains(event.target)) return
            closeMenu()
          }
          function onKeyDown(event) {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeMenu()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            indexRef.current = (indexRef.current + delta + MENU_ITEMS.length) % MENU_ITEMS.length
            const node = menuRef.current
            if (node === null) return
            const rows = node.querySelectorAll('[data-aipol-row]')
            const row = rows[indexRef.current]
            if (row !== undefined && typeof row.focus === 'function') row.focus()
          }
          // 注意：窗口滚动由下面的独立 effect 处理（需要区分"菜单内部滚动"，
          // 否则展开「使用说明」后在内层滚动会立刻把菜单关掉）。
          function onResize() { closeMenu() }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('resize', onResize, true)
          return function () {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onResize, true)
          }
        }, [])

        // 定位：先用估算值给出初始位置（避免首帧跳一下），挂载后再用**实测高度**
        // 归一化。菜单内容会因「使用说明」展开而变高，估算值只能当起点。
        const MENU_WIDTH = 260
        const estimatedHeight = 240
        const vw = (typeof window !== 'undefined' ? window.innerWidth : 1280)
        const vh = (typeof window !== 'undefined' ? window.innerHeight : 800)
        const viewportMargin = 8

        const placeState = React.useState(function () {
          let left = state.menuAt.x
          let top = state.menuAt.y
          if (left + MENU_WIDTH > vw - viewportMargin) left = Math.max(viewportMargin, vw - MENU_WIDTH - viewportMargin)
          if (top + estimatedHeight > vh - viewportMargin) {
            top = Math.max(viewportMargin, state.menuAt.y - estimatedHeight - 34)
          }
          return { top: top, maxHeight: vh - 2 * viewportMargin, settled: false }
        })
        const place = placeState[0]
        const setPlace = placeState[1]

        // 菜单内部滚动区：让「使用说明」展开的内容在自己的盒子里滚，而不是把菜单撑出屏幕
        const listRef = React.useRef(null)

        React.useLayoutEffect(function () {
          const node = menuRef.current
          if (node === null) return
          const height = node.offsetHeight
          const width = node.offsetWidth || MENU_WIDTH
          const maxHeight = Math.max(160, vh - 2 * viewportMargin)
          const fitted = Math.min(height, maxHeight)

          let left = state.menuAt.x
          if (left + width > vw - viewportMargin) left = Math.max(viewportMargin, vw - width - viewportMargin)

          let top = state.menuAt.y
          if (top + fitted > vh - viewportMargin) {
            // 优先向上翻转（右击点往上展开），真的放不下再夹到可容纳的范围
            const above = state.menuAt.y - fitted - 34
            top = above >= viewportMargin ? above : Math.max(viewportMargin, vh - fitted - viewportMargin)
          }

          setPlace({ top: top, maxHeight: maxHeight, settled: true })
        }, [helpOpen, state.menuAt.x, state.menuAt.y, vh, vw])

        // 菜单内部滚动不应关闭菜单；窗口/页面滚动才关闭
        React.useEffect(function () {
          function onScroll(event) {
            const list = listRef.current
            if (list !== null && event.target === list) return
            if (list !== null && list.contains(event.target)) return
            closeMenu()
          }
          window.addEventListener('scroll', onScroll, true)
          return function () {
            window.removeEventListener('scroll', onScroll, true)
          }
        }, [])

        function rowStyle(delayIndex) {
          return {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            minHeight: '40px',
            padding: '0 10px',
            border: 'none',
            background: 'transparent',
            color: COLOR_TEXT,
            fontFamily: 'inherit',
            fontSize: '14px',
            lineHeight: '1.3',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '8px',
            boxSizing: 'border-box',
            transform: visible ? 'none' : 'translateY(-3px)',
            transition: motion(260),
            transitionDelay: visible ? (delayIndex * 18) + 'ms' : '0ms',
            opacity: visible ? 1 : 0,
          }
        }

        function rowInteractions(disabled) {
          return {
            onMouseEnter: function (event) {
              if (!disabled) event.currentTarget.style.background = HOVER_BG
            },
            onMouseLeave: function (event) { event.currentTarget.style.background = 'transparent' },
            onMouseDown: function (event) {
              if (!disabled) event.currentTarget.style.transform = 'scale(.97)'
            },
            onMouseUp: function (event) { event.currentTarget.style.transform = 'none' },
          }
        }

        const rows = MENU_ITEMS.map(function (item, position) {
          if (item.kind === 'switch') {
            const on = state.prefs[item.id] === true
            return React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                'data-aipol-row': true,
                style: rowStyle(position),
                onClick: function () {
                  const patch = {}
                  patch[item.id] = on !== true
                  setPrefs(patch)
                },
                ...rowInteractions(false),
              },
              React.createElement('span', { style: { flex: '1 1 auto' } }, item.label),
              React.createElement(IosSwitch, { checked: on, label: item.label }),
            )
          }

          if (item.kind === 'cycle') {
            const current = state.prefs.autoPreviewChars
            return React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                'data-aipol-row': true,
                style: rowStyle(position),
                onClick: function () {
                  const at = CHAR_LIMIT_STEPS.indexOf(current)
                  const next = CHAR_LIMIT_STEPS[(at + 1) % CHAR_LIMIT_STEPS.length]
                  setPrefs({ autoPreviewChars: next })
                },
                ...rowInteractions(false),
              },
              React.createElement('span', { style: { flex: '1 1 auto' } }, item.label),
              React.createElement('span', { style: { color: COLOR_MUTED, fontSize: '13px' } }, charLimitLabel(current)),
            )
          }

          const disabled = item.id === 'regen'
            && (store.liveDraft.trim() === '' || store.previewLoading === true)
          return React.createElement(
            'button',
            {
              key: item.id,
              type: 'button',
              'data-aipol-row': true,
              disabled: disabled,
              style: {
                ...rowStyle(position),
                color: disabled ? COLOR_CAPTION : COLOR_TEXT,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : (visible ? 1 : 0),
              },
              onClick: function () {
                if (disabled) return
                if (item.id === 'help') {
                  setHelpOpen(!helpOpen)
                  return
                }
                closeMenu()
                generate(store.liveDraft, { manual: true })
              },
              ...rowInteractions(disabled),
            },
            React.createElement('span', { style: { flex: '1 1 auto' } }, item.label),
            item.id === 'help'
              ? React.createElement('span', { style: { color: COLOR_CAPTION, fontSize: '12px' } }, helpOpen ? '收起' : '展开')
              : null,
          )
        })

        const helpPanel = helpOpen
          ? React.createElement(
            'div',
            {
              style: {
                padding: '2px 10px 8px 10px',
                color: COLOR_MUTED,
                fontSize: '12px',
                lineHeight: '1.6',
              },
            },
            HELP_LINES.map(function (line, index) {
              return React.createElement('div', { key: String(index) }, '· ' + line)
            }),
          )
          : null

        const menuHeader = React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px 8px',
              borderBottom: '1px solid ' + COLOR_BORDER,
              marginBottom: '4px',
              flex: 'none',
              color: COLOR_MUTED,
              fontSize: '13px',
              fontWeight: 600,
            },
          },
          React.createElement('span', null, '✨'),
          React.createElement('span', null, 'AI 润色'),
        )

        const menuFooter = React.createElement(
          'div',
          {
            style: {
              padding: '8px 10px 4px',
              borderTop: '1px solid ' + COLOR_BORDER,
              marginTop: '4px',
              flex: 'none',
              color: COLOR_CAPTION,
              fontSize: '11px',
            },
          },
          'v' + VERSION + ' · 本机运行 · 预览不额外计费',
        )

        // 结构：固定头部 + 内部滚动区（条目与使用说明）+ 固定页脚。
        // 内容超过屏幕时，滚动发生在这个内层盒子里，而不是把菜单撑出可视区。
        return React.createElement(
          'div',
          {
            ref: menuRef,
            role: 'menu',
            'aria-label': 'AI 润色设置',
            style: {
              position: 'fixed',
              left: state.menuAt.x + 'px',
              top: place.top + 'px',
              width: MENU_WIDTH + 'px',
              maxHeight: place.maxHeight + 'px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              padding: '6px',
              borderRadius: '14px',
              background: GLASS_BG,
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              border: '1px solid ' + COLOR_BORDER,
              boxShadow: PANEL_SHADOW,
              zIndex: 10001,
              overflow: 'hidden',
              opacity: (visible && place.settled) ? 1 : 0,
              transform: (visible && place.settled) ? 'scale(1) translateY(0)' : 'scale(.92) translateY(-4px)',
              transformOrigin: 'top left',
              transition: motion(260),
            },
          },
          menuHeader,
          React.createElement(
            'div',
            {
              ref: listRef,
              style: {
                flex: '1 1 auto',
                minHeight: '0',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                scrollbarWidth: 'thin',
              },
            },
            ...rows,
            helpPanel,
          ),
          menuFooter,
        )
      }

      // ------------------------------------------------------------------
      // 预览卡片（浮在输入卡片上方）；右击菜单也在这里渲染（fixed 定位）
      // ------------------------------------------------------------------
      function PreviewCard(props) {
        const state = usePolishStore()
        const input = useComposerInput(props)

        // 右击菜单与预览卡片互不依赖：菜单即使没有任何预览也必须能弹出
        const menu = state.menuOpen === true ? React.createElement(SettingsMenu, null) : null
        const status = state.previewStatus
        const hint = typeof state.hint === 'string' ? state.hint : ''
        if (hint === '' && (state.hovering !== true || status === 'idle')) return menu

        const fingerprint = String(state.previewFingerprint === null ? '' : state.previewFingerprint)
        const changed = status === 'preview' && input.draft.trim() !== fingerprint

        let body = null
        if (hint !== '' && status === 'idle') {
          // 轻提示（如"请先输入需要润色的内容"）：不调模型、不花 token
          body = React.createElement(
            'div',
            { style: { color: COLOR_MUTED, fontSize: '13px' } },
            hint,
          )
        } else if (status === 'loading') {
          body = React.createElement(
            'div',
            { style: { color: COLOR_MUTED, fontSize: '13px' } },
            '正在润色…' + (state.prefs.showCost === true ? '（本次约 ' + estimateFor(fingerprint) + ' tokens）' : ''),
          )
        } else if (status === 'error') {
          body = React.createElement(
            'div',
            { style: { color: COLOR_ERROR, fontSize: '13px' } },
            state.previewError === '' ? '润色失败' : state.previewError,
          )
        } else if (status === 'gate') {
          body = React.createElement(
            'button',
            {
              type: 'button',
              style: {
                border: 'none',
                background: 'transparent',
                color: COLOR_BUSINESS,
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: '13px',
                textAlign: 'left',
              },
              onClick: function () { generate(input.draft, { manual: true }) },
            },
            '草稿较长（' + fingerprint.length + ' 字），约需 ' + estimateFor(fingerprint)
              + ' tokens — 点此生成预览',
          )
        } else if (status === 'preview') {
          body = React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              {
                style: {
                  maxHeight: '180px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: COLOR_TEXT,
                  fontSize: '14px',
                  lineHeight: '1.55',
                },
              },
              state.previewText,
            ),
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  marginTop: '8px',
                },
              },
              React.createElement(
                'div',
                { style: { color: changed ? COLOR_ERROR : COLOR_CAPTION, fontSize: '11px', minWidth: 0 } },
                changed
                  ? '草稿已改动，不会被覆盖'
                  : (state.previewFromCache === true
                    ? '沿用上次结果 · 0 tokens'
                    : (state.prefs.showCost === true
                      ? (formatUsage(state.previewUsage) || '润色完成')
                      : '润色完成')),
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '6px', flex: 'none' } },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: changed,
                    style: {
                      height: '26px',
                      padding: '0 12px',
                      borderRadius: '999px',
                      border: '1px solid ' + (changed ? COLOR_MUTED : COLOR_BUSINESS),
                      background: changed ? 'transparent' : COLOR_BUSINESS,
                      color: changed ? COLOR_MUTED : '#fff',
                      cursor: changed ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      transition: motion(140),
                    },
                    onClick: function () { accept(actionsOf(props), input.draft) },
                  },
                  '采纳',
                ),
                changed
                  ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: {
                        height: '26px',
                        padding: '0 10px',
                        borderRadius: '999px',
                        border: '1px solid ' + COLOR_BORDER,
                        background: 'transparent',
                        color: COLOR_TEXT,
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontFamily: 'inherit',
                      },
                      onClick: function () { generate(input.draft, { manual: true }) },
                    },
                    '重新生成',
                  )
                  : null,
              ),
            ),
          )
        }

        return React.createElement(
          'div',
          null,
          menu,
          React.createElement(
            'div',
            {
              style: {
                position: 'absolute',
                left: '0',
                right: '0',
                bottom: '100%',
                marginBottom: '8px',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: '14px',
                background: SOLID_BG,
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                border: '1px solid ' + COLOR_BORDER,
                boxShadow: PANEL_SHADOW,
                transition: motion(220),
              },
            },
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginBottom: '6px',
                  color: COLOR_MUTED,
                  fontSize: '11px',
                  fontWeight: 600,
                },
              },
              React.createElement('span', null, '✨'),
              React.createElement('span', null, (hint !== '' && status === 'idle') ? 'AI 润色' : 'AI 润色预览'),
            ),
            body,
          ),
        )
      }

      // ------------------------------------------------------------------
      // 主按钮：悬停预览 / 左键采纳 / 右击菜单
      // ------------------------------------------------------------------
      function PolishButton(props) {
        const state = usePolishStore()
        const input = useComposerInput(props)
        const draft = input.draft
        const actions = actionsOf(props)
        const canWrite = actions !== null && actions !== undefined && typeof actions.setDraft === 'function'

        const hoverTimer = React.useRef(null)
        const pressedState = React.useState(false)
        const pressed = pressedState[0]
        const setPressed = pressedState[1]

        const busy = state.previewLoading === true && state.previewStatus === 'loading'
        // 按钮常亮：只有"根本没法写入输入框"时才不可点。没有草稿不再是禁用理由，
        // 这样右击菜单随时可用；空草稿点击时改为给出轻提示。
        const disabled = !canWrite

        React.useEffect(function () {
          return function () {
            if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
          }
        }, [])

        function onEnter() {
          if (disabled) return
          beginHover()
          if (state.prefs.hoverPreview !== true) return
          // 悬停预览仍需有草稿才可能有意义
          if (state.liveDraft.trim() === '') return
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
          hoverTimer.current = setTimeout(function () {
            hoverTimer.current = null
            requestPreview()
          }, HOVER_DELAY_MS)
        }

        function onLeave() {
          if (hoverTimer.current !== null) {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = null
          }
          endHover()
        }

        function onContextMenu(event) {
          event.preventDefault()
          event.stopPropagation()
          if (disabled) return
          // 菜单按 store.liveDraft 判断「立即重新生成」是否可用；liveDraft 只在
          // 输入组件渲染时写入，菜单可能先渲染，所以这里用当前草稿即时校正。
          store.liveDraft = draft
          const rect = event.currentTarget.getBoundingClientRect()
          openMenu(Math.round(rect.left), Math.round(rect.bottom + 6))
        }

        function onPolishClick() {
          if (disabled) return
          const source = draft.trim()

          // 空草稿：不再禁用按钮，而是给出轻提示
          if (source === '') {
            showHint('请先输入需要润色的内容')
            return
          }
          if (input.phase !== 'plain') {
            showHint('模型正在处理上一条消息，请稍候')
            return
          }
          // 已有同草稿预览 → 直接采纳，不再花钱
          if (state.previewStatus === 'preview'
            && state.previewFingerprint === source
            && typeof state.previewText === 'string') {
            accept(actions, draft)
            return
          }
          // 否则即时润色并替换（触屏用户与未开启预览者的既有行为）
          state.original = source
          state.applied = null
          state.status = 'loading'
          state.error = ''
          state.usage = null
          notify()
          callPolish(source).then(function (result) {
            state.applied = result.text
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

        const showRevert = state.applied !== null && state.original !== null && draft === state.applied

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
          transform: pressed ? 'scale(.97)' : 'scale(1)',
          transition: motion(140),
          whiteSpace: 'nowrap',
          flex: 'none',
        }

        const revertStyle = {
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
            onClick: onPolishClick,
            onContextMenu: onContextMenu,
            onMouseEnter: onEnter,
            onMouseLeave: onLeave,
            onMouseDown: function () { setPressed(true) },
            onMouseUp: function () { setPressed(false) },
            onBlur: function () { setPressed(false) },
            style: buttonStyle,
            'aria-label': 'AI 润色（右键设置）',
          },
          React.createElement('span', { style: { fontSize: '12px' } }, '✨'),
          React.createElement('span', null, busy ? '润色中…' : 'AI 润色'),
        )

        if (!showRevert) return mainButton

        return React.createElement(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', flex: 'none' } },
          mainButton,
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () { revert(actions) },
              style: revertStyle,
              title: '还原为润色前的原始草稿',
              'aria-label': '还原原始草稿',
            },
            React.createElement('span', null, '↺'),
            React.createElement('span', null, '还原'),
          ),
        )
      }

      // ------------------------------------------------------------------
      // Token 统计（输入框右下角）
      // ------------------------------------------------------------------
      function TokenStats(props) {
        const state = usePolishStore()
        const input = useComposerInput(props)
        const draft = input.draft

        let content = null
        let color = COLOR_MUTED
        let title = '预估基于字符启发式估算，实际值以模型返回的用量为准'

        if (state.previewStatus === 'loading') {
          content = '润色中…'
        } else if (state.status === 'error') {
          content = '润色失败' + (state.error !== '' ? ' · ' + state.error : '')
          color = COLOR_ERROR
          title = state.error
        } else if (state.status === 'done' && state.prefs.showCost === true) {
          content = formatUsage(state.usage) || '润色完成'
          title = '本次润色请求的实际 token 用量'
        } else if (draft.trim() !== '') {
          content = '预估本次润色 ≈ ' + estimateFor(draft) + ' tokens'
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

        if (content === null) return React.createElement('div', { style: style }, '\u00A0')
        return React.createElement('div', { style: style, title: title }, content)
      }

      // ------------------------------------------------------------------
      // 注册三个槽位；disposer 归当前 Fiber，插件停止/重载时自动撤销
      // ------------------------------------------------------------------
      ctx.effect(function () {
        const disposeButton = slots.inject('conversation.input.right', function () {
          return slots.register(
            { name: 'conversation.input.right', id: 'ai-polish-button', order: 20, label: 'AI 润色' },
            PolishButton,
          )
        })

        const disposeOverlay = slots.inject('conversation.input.overlay', function () {
          return slots.register(
            { name: 'conversation.input.overlay', id: 'ai-polish-preview', order: 20, label: 'AI 润色预览' },
            PreviewCard,
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
          if (typeof disposeOverlay === 'function') disposeOverlay()
          if (typeof disposeStats === 'function') disposeStats()
          store.listeners.clear()
        }
      }, 'ai-polish: composer UI')
    }

    exports.apply = apply
    // 只依赖 slots；inputActions / useInput 由槽位的标准 props 提供。
    exports.inject = ['slots']
    exports.__aipolVersion = VERSION
    return exports
  },
})
