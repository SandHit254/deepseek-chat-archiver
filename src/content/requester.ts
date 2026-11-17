import type { ApiRequester } from '../core/api'

/**
 * 与 background 通信的请求器。
 *
 * 内容脚本与面板都不直接发 HTTP：所有请求经 background 代理。
 * 原因：隔离世界与 Shadow DOM 里发出的请求不带页面的 Authorization，
 * 而 background 有 host_permissions，也不受 SPA 刷新影响。
 */
export function createBackgroundRequester(): ApiRequester {
  return async (path) => {
    const response = await chrome.runtime.sendMessage({
      type: 'api:request',
      payload: { path },
    }) as { ok: boolean; status?: number; body?: string; error?: string } | undefined

    if (!response) {
      throw new Error('后台无响应，请重新加载扩展')
    }
    if (response.error === 'NO_TOKEN') {
      throw new Error('尚未捕获到登录凭证：请刷新 DeepSeek 页面，或先发一条消息再试')
    }
    if (response.error === 'BAD_PATH') {
      throw new Error('请求路径不被允许')
    }
    if (response.error) {
      throw new Error(`请求失败：${response.error}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('登录态已失效，请刷新页面后重试')
    }
    if (!response.ok) {
      throw new Error(`接口返回 HTTP ${response.status ?? '未知'}`)
    }

    try {
      return JSON.parse(response.body ?? '{}')
    } catch {
      throw new Error('响应不是合法 JSON，DeepSeek 接口可能已变更')
    }
  }
}