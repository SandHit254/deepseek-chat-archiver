import type { ApiRequester } from '../core/api'
import type { ApiEnvelope } from '../core/types'

/**
 * 请求器：通过页面主世界代发 API 请求。
 *
 * 为什么不在 background 里直接 fetch（之前那版的做法，会返回 400）：
 * chat.deepseek.com 位于华为云 WAF 之后，服务端硬性要求
 *   - Cookie：HWWAFSESID / HWWAFSESTIME 等 WAF 会话标记
 *   - 客户端身份头：x-client-platform: web、x-app-version、x-client-version…
 *   - Origin / Referer / Sec-Fetch-* 三者自洽
 * service worker 里 credentials:'omit' 发出的请求一条都不满足，直接被判非法。
 *
 * 而页面主世界发的请求天然满足以上全部条件（Cookie 自动带、Sec-Fetch-*
 * 与 Origin 由浏览器按同源补齐）。所以这里把请求委托给 pageHook 执行。
 */

export const REQUEST_EVENT = 'ds-archiver:request'

let counter = 0

interface BridgeResponse {
  ok: boolean
  status?: number
  body?: string
  error?: string
}

export function createPageBridgeRequester(): ApiRequester {
  return async (path, options = {}) => {
    counter += 1
    const id = `req_${Date.now()}_${counter}`
    const responseEvent = `ds-archiver:response:${id}`

    return new Promise((resolve, reject) => {
      let settled = false
      let timer = 0

      const cleanup = (): void => {
        window.removeEventListener(responseEvent, onResponse)
        options.signal?.removeEventListener('abort', onAbort)
        if (timer !== 0) window.clearTimeout(timer)
      }

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const onAbort = (): void => {
        fail(new Error('已取消'))
      }

      const onResponse = (event: Event): void => {
        if (settled) return
        const detail = (event as CustomEvent<BridgeResponse>).detail

        if (!detail) {
          fail(new Error('请求通道响应为空'))
          return
        }
        if (detail.error === 'BAD_PATH') {
          fail(new Error('请求路径不被允许'))
          return
        }
        if (detail.error) {
          fail(new Error(`请求失败：${detail.error}`))
          return
        }
        if (detail.status === 401 || detail.status === 403) {
          fail(new Error('登录态已失效，请刷新页面后重试'))
          return
        }
        // 把服务端返回体原样抛出来，便于定位 400 之类的问题
        if (detail.status !== undefined && detail.status >= 400) {
          const snippet = (detail.body ?? '').slice(0, 200)
          fail(new Error(`接口返回 HTTP ${detail.status}${snippet ? `：${snippet}` : ''}`))
          return
        }

        let parsed: ApiEnvelope<unknown>
        try {
          parsed = JSON.parse(detail.body ?? '{}') as ApiEnvelope<unknown>
        } catch {
          fail(new Error('响应不是合法 JSON，DeepSeek 接口可能已变更'))
          return
        }
        if (settled) return
        settled = true
        cleanup()
        resolve(parsed)
      }

      timer = window.setTimeout(() => {
        fail(new Error('请求超时，请刷新页面后重试（页面钩子可能未注入）'))
      }, 30_000)

      if (options.signal?.aborted) {
        fail(new Error('已取消'))
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      window.addEventListener(responseEvent, onResponse)

      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { id, path } }))
    })
  }
}