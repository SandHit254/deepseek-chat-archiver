/**
 * 主世界 token 嗅探的接收端。
 *
 * 隔离世界读不到页面 fetch 的请求头，所以 pageHook 在 MAIN world 抄一份
 * Authorization，通过自定义事件交给这里，再由本脚本转存进 background。
 *
 * 之后所有网络请求都由 background 发起（它有 host_permissions，不受
 * 页面 CORS 约束），content script 自己不发任何请求。
 */

export const TOKEN_EVENT = 'ds-archiver:token'
export const READY_EVENT = 'ds-archiver:ready'

/** 把 pageHook.js 注入页面主世界 */
export function injectPageHook(): void {
  if (document.getElementById('ds-archiver-page-hook')) return

  const script = document.createElement('script')
  script.id = 'ds-archiver-page-hook'
  script.src = chrome.runtime.getURL('pageHook.js')
  script.type = 'text/javascript'
  script.onload = () => script.remove()
  ;(document.head ?? document.documentElement).appendChild(script)
}

/**
 * 等待主世界交出 token。
 *
 * 两种来源任一即可：
 * - ready 事件（pageHook 加载完立即广播）
 * - token 事件（页面后续发请求时嗅到）
 * 超时返回空串，让上层决定是提示还是继续（面板会给出刷新指引）。
 */
export function waitForBridge(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (token: string): void => {
      if (settled) return
      settled = true
      window.removeEventListener(READY_EVENT, onReady)
      window.removeEventListener(TOKEN_EVENT, onToken)
      resolve(token)
    }

    const onReady = (event: Event): void => {
      const detail = (event as CustomEvent<{ token?: string }>).detail
      finish(detail?.token ?? '')
    }
    const onToken = (event: Event): void => {
      const detail = (event as CustomEvent<{ token?: string }>).detail
      if (detail?.token) finish(detail.token)
    }

    window.addEventListener(READY_EVENT, onReady)
    window.addEventListener(TOKEN_EVENT, onToken)
    setTimeout(() => finish(''), timeoutMs)
  })
}

/**
 * 把 token 交给 background 保管。
 *
 * token 只存在 background 的内存里，不写 storage、不落盘——
 * 关掉浏览器就失效，减少泄露面。
 */
export async function handTokenToBackground(token: string): Promise<void> {
  if (token === '') return
  try {
    await chrome.runtime.sendMessage({ type: 'auth:token', payload: { token } })
  } catch {
    // background 未就绪时忽略，后续 token 事件还会再送一次
  }
}

/**
 * 持续监听 token 变化。
 *
 * DeepSeek 会刷新 token，页面每次请求都会带新的。持续转发保证长会话
 * 导出过程中不会因为 token 过期中断。
 */
export function relayTokenUpdates(): () => void {
  const onToken = (event: Event): void => {
    const detail = (event as CustomEvent<{ token?: string }>).detail
    if (detail?.token) void handTokenToBackground(detail.token)
  }
  window.addEventListener(TOKEN_EVENT, onToken)
  return () => window.removeEventListener(TOKEN_EVENT, onToken)
}