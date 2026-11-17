/**
 * 页面主世界（MAIN world）的 token 嗅探器。
 *
 * 为什么需要它：扩展内容脚本跑在隔离世界，读不到页面 fetch 的请求头。
 * DeepSeek 的 Authorization 头只在请求里出现，最稳的拿法就是钩住页面
 * 自己的 fetch / XHR 被动抄一份，而不是去 localStorage 里猜键名与加密方式。
 *
 * 硬约束：
 * - 只读嗅探：不改请求、不改响应、不阻断任何逻辑，页面行为必须完全不变
 * - 只抓 token，不抓正文：正文由 background 主动请求获得
 * - 任何异常静默降级，绝不能让页面白屏
 *
 * 本文件以 web_accessible_resources + script 标签方式注入（MV3 禁止内联脚本）。
 */
;(function pageHook() {
  const TOKEN_KEY = '__ds_archiver_token__'
  const TOKEN_EVENT = 'ds-archiver:token'
  const READY_EVENT = 'ds-archiver:ready'

  // SPA 路由切换可能重复注入，用标记防重复挂钩
  const flag = '__dsArchiverHooked__'
  const globalObject = window as unknown as Record<string, unknown>
  if (globalObject[flag]) return
  globalObject[flag] = true

  let lastToken = ''
  let lastTokenAt = 0

  /**
   * 从请求头里捞 authorization。
   * headers 可能是 Headers 实例、普通对象或数组三种形态，都要覆盖。
   */
  function extractAuth(headers: unknown): string | null {
    if (!headers) return null

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get('authorization') || null
    }

    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].toLowerCase() === 'authorization') {
          return typeof entry[1] === 'string' ? entry[1] : null
        }
      }
      return null
    }

    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === 'authorization' && typeof value === 'string') return value
      }
    }
    return null
  }

  function currentToken(): string {
    if (lastToken) return lastToken

    try {
      const cached = sessionStorage.getItem(TOKEN_KEY)
      if (cached) return cached
    } catch {
      // 忽略
    }

    /*
     * 兜底：页面还没发过任何请求时，嗅探不到 token（打开面板早于页面活动）。
     * 此时直接读 localStorage。
     *
     * 注意 DeepSeek 存的可能是 JSON 信封 { value: '...', __version: '1' }，
     * 必须取内层 value，把整个信封当 token 会被判 INVALID_TOKEN。
     */
    try {
      for (const key of ['userToken', 'user_token', '__user_token__']) {
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const value = parseStoredToken(raw)
        if (value) {
          lastToken = value
          lastTokenAt = Date.now()
          return value
        }
      }
    } catch {
      // localStorage 不可用时忽略
    }

    return ''
  }

  /** 从 localStorage 的原始值里取出真正的 token 字符串 */
  function parseStoredToken(raw: string): string {
    const trimmed = raw.trim()
    if (trimmed === '') return ''
    if (!trimmed.startsWith('{')) return trimmed

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const key of ['value', 'token', 'access_token', 'authorization']) {
        const candidate = parsed[key]
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
      // 有些版本是 { value: { value: '...' } } 的嵌套结构
      const nested = parsed.value
      if (nested && typeof nested === 'object') {
        const inner = (nested as Record<string, unknown>).value
        if (typeof inner === 'string' && inner !== '') return inner
      }
    } catch {
      // 不是合法 JSON，按原样返回
    }
    return trimmed
  }

  function publishToken(token: string | null): void {
    if (!token) return
    // 同 token 不重复广播，减少事件噪音
    if (token === lastToken && Date.now() - lastTokenAt < 60_000) return
    lastToken = token
    lastTokenAt = Date.now()

    try {
      // sessionStorage 只是同标签页的暂存口，便于刷新后立即恢复
      sessionStorage.setItem(TOKEN_KEY, token)
      window.dispatchEvent(new CustomEvent(TOKEN_EVENT, { detail: { token } }))
    } catch {
      // 隐私模式下可能抛错，忽略
    }
  }

  function isApiUrl(input: unknown): boolean {
    try {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input === 'object' && 'url' in input
            ? String((input as { url: unknown }).url)
            : ''
      if (!raw) return false
      const url = new URL(raw, location.href)
      return url.origin === location.origin && url.pathname.startsWith('/api/')
    } catch {
      return false
    }
  }

  /* ---------------------------------------------------------------- *
   * fetch 钩子
   * ---------------------------------------------------------------- */
  const originalFetch = window.fetch
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      if (isApiUrl(input)) {
        const token = extractAuth(init?.headers)
          // Request 对象上的头需要单独读
          ?? (typeof Request !== 'undefined' && input instanceof Request
            ? input.headers.get('authorization')
            : null)
        publishToken(token)
      }
    } catch {
      // 嗅探失败绝不能影响页面请求
    }
    return originalFetch.call(this, input as RequestInfo, init)
  }

  /* ---------------------------------------------------------------- *
   * 主动请求通道
   *
   * 为什么必须由页面主世界代发：chat.deepseek.com 位于华为云 WAF 之后，
   * 服务端要求 Cookie（HWWAFSESID / HWWAFSESTIME）与一组客户端身份头
   * （x-client-platform、x-app-version…），还要求 Origin/Referer/
   * Sec-Fetch-* 三者自洽。这些只有页面自己发请求时才是天然正确的——
   * 从 service worker 或隔离世界发，缺 Cookie 会被直接判 400。
   *
   * 因此：内容脚本只负责转达请求意图，真正的 fetch 在这里执行。
   * ---------------------------------------------------------------- */

  interface BridgeRequest {
    id: string
    path: string
  }

  function reply(id: string, payload: unknown): void {
    window.dispatchEvent(new CustomEvent(`ds-archiver:response:${id}`, { detail: payload }))
  }

  window.addEventListener('ds-archiver:request', (event) => {
    const detail = (event as CustomEvent<BridgeRequest>).detail
    if (!detail || typeof detail.path !== 'string' || typeof detail.id !== 'string') return

    // 只允许本域 /api/ 只读路径，防止这个通道被当成任意请求代理
    if (!detail.path.startsWith('/api/')) {
      reply(detail.id, { ok: false, error: 'BAD_PATH' })
      return
    }

    /*
     * 两件东西缺一不可：
     *   1. Authorization —— DeepSeek 的业务鉴权头，缺了会返回 INVALID_TOKEN
     *   2. Cookie —— WAF 层的 HWWAFSESID/HWWAFSESTIME，缺了会被 WAF 挡成 400
     * 前者要从嗅探到的值里取，后者由 credentials:'include' 自动带。
     */
    const token = currentToken()
    if (!token) {
      reply(detail.id, { ok: false, error: 'NO_TOKEN' })
      return
    }

    // 用页面原生 fetch：Cookie 自动带上，Sec-Fetch-* 与 Origin 由浏览器补齐，
    // 与用户在页面上正常操作时完全一致。
    void originalFetch
      .call(window, detail.path, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: '*/*',
          authorization: token,
        },
      })
      .then(async (response) => {
        const text = await response.text()
        reply(detail.id, { ok: response.ok, status: response.status, body: text })
      })
      .catch((error: unknown) => {
        reply(detail.id, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
  })

  /* ---------------------------------------------------------------- *
   * fetch 钩子（只读嗅探）
   * ---------------------------------------------------------------- */
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      if (isApiUrl(input)) {
        const token = extractAuth(init?.headers)
          // Request 对象上的头需要单独读
          ?? (typeof Request !== 'undefined' && input instanceof Request
            ? input.headers.get('authorization')
            : null)
        publishToken(token)
      }
    } catch {
      // 嗅探失败绝不能影响页面请求
    }
    return originalFetch.call(this, input as RequestInfo, init)
  }
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    try {
      ;(this as unknown as Record<string, unknown>).__dsArchiverUrl = String(url)
    } catch {
      // 忽略
    }
    return (originalOpen as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    try {
      const url = (this as unknown as Record<string, unknown>).__dsArchiverUrl
      if (typeof url === 'string' && isApiUrl(url) && name.toLowerCase() === 'authorization') {
        publishToken(value)
      }
    } catch {
      // 忽略
    }
    return originalSetRequestHeader.call(this, name, value)
  }

  // 就绪广播。用 setTimeout 让内容脚本有机会先挂好监听
  setTimeout(() => {
    try {
      window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { token: currentToken() } }))
    } catch {
      // 忽略
    }
  }, 0)
})()