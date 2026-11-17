/**
 * Background service worker。
 *
 * 职责：
 * 1. 保管登录 token（只在内存，不落盘）
 * 2. 代理所有 DeepSeek API 请求——它有 host_permissions，不受页面 CORS 限制
 * 3. 下载附件
 * 4. 用 chrome.downloads 保存最终 zip
 *
 * 为什么不把请求放在 content script：隔离世界发起的请求不带页面的
 * Authorization 头，而 iframe 面板更是跨上下文。统一收敛到 background，
 * 逻辑只有一份，也不受 SPA 刷新影响。
 */

/* ------------------------------------------------------------------ *
 * Token 保管
 * ------------------------------------------------------------------ */

interface TokenState {
  value: string
  updatedAt: number
}

let tokenState: TokenState | null = null

/** token 超过这个时长就认为不可信，提示刷新（DeepSeek 的实际有效期更长，留余量） */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000

function setToken(token: string): void {
  if (typeof token !== 'string' || token.trim() === '') return
  tokenState = { value: token.trim(), updatedAt: Date.now() }
}

function getToken(): string | null {
  if (!tokenState) return null
  if (Date.now() - tokenState.updatedAt > TOKEN_TTL_MS) return null
  return tokenState.value
}

/* ------------------------------------------------------------------ *
 * API 代理
 * ------------------------------------------------------------------ */

const API_ORIGIN = 'https://chat.deepseek.com'

/** 只允许访问这些路径前缀，防止消息通道被当成任意请求代理 */
const ALLOWED_PATH_PREFIXES = ['/api/v0/chat_session/', '/api/v0/chat/', '/api/v0/users/']

interface ApiProxyResult {
  ok: boolean
  status?: number
  body?: string
  error?: string
}

async function proxyApiRequest(path: string): Promise<ApiProxyResult> {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    return { ok: false, error: 'BAD_PATH' }
  }
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { ok: false, error: 'BAD_PATH' }
  }
  // 查询串里不允许出现协议或域名，杜绝 SSRF 式拼接
  if (/^\/api\/[^?]*\?.*(?:https?:|\/\/)/i.test(path)) {
    return { ok: false, error: 'BAD_PATH' }
  }

  const token = getToken()
  if (!token) {
    return { ok: false, error: 'NO_TOKEN' }
  }

  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        authorization: token,
        accept: '*/*',
      },
    })

    const body = await response.text()
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 附件下载
 * ------------------------------------------------------------------ */

interface AttachmentResult {
  ok: boolean
  dataUrl?: string
  mimeType?: string
  byteLength?: number
  error?: string
}

/**
 * 单个附件体积上限。
 * 超限跳过并记录——存档要的是整体可用，不能被一个大文件拖垮。
 */
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024

/** 附件域名白名单：只允许 DeepSeek 自己的文件服务 */
const ALLOWED_ATTACHMENT_HOSTS = ['files.deepseeksvc.com', 'chat.deepseek.com']

function toDataUrl(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([buffer], { type: mimeType })
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('附件转码失败'))
      reader.readAsDataURL(blob)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function downloadAttachment(url: string): Promise<AttachmentResult> {
  if (typeof url !== 'string' || url === '') {
    return { ok: false, error: '附件地址为空' }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: '附件地址不合法' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: '附件地址必须是 https' }
  }
  if (!ALLOWED_ATTACHMENT_HOSTS.includes(parsed.hostname)) {
    return { ok: false, error: `不允许的附件域名：${parsed.hostname}` }
  }

  try {
    const response = await fetch(parsed.href, {
      method: 'GET',
      credentials: 'omit',
      headers: { referer: 'https://chat.deepseek.com/' },
    })

    if (!response.ok) {
      return { ok: false, error: `附件下载失败 HTTP ${response.status}` }
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `附件过大（${Math.round(declaredLength / 1024 / 1024)} MB），已跳过` }
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `附件过大（${Math.round(buffer.byteLength / 1024 / 1024)} MB），已跳过` }
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim()
      || 'application/octet-stream'

    // 签名过期时文件服务回 HTML 错误页，不能当附件存下来
    if (mimeType.startsWith('text/html')) {
      return { ok: false, error: '附件链接已失效（签名可能过期），已跳过' }
    }

    const dataUrl = await toDataUrl(buffer, mimeType)
    return { ok: true, dataUrl, mimeType, byteLength: buffer.byteLength }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 保存归档
 * ------------------------------------------------------------------ */

/**
 * 用 data URL 交给 chrome.downloads。
 *
 * 不用 blob URL：MV3 的 service worker 里 URL.createObjectURL 不可用，
 * 且 worker 休眠会让 blob 引用失效。
 */
async function saveArchive(dataUrl: string, filename: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:application/zip')) {
    return { ok: false, error: '归档数据格式不正确' }
  }
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
    })
    if (downloadId === undefined) return { ok: false, error: '下载未启动' }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

type Handler = (payload: unknown) => Promise<unknown> | unknown

interface Message {
  type?: unknown
  payload?: unknown
}

const handlers: Record<string, Handler> = {
  'auth:token': (payload) => {
    const data = payload as { token?: string } | undefined
    if (data?.token) setToken(data.token)
    return { ok: true }
  },

  'auth:status': () => ({ ok: true, hasToken: getToken() !== null }),

  'api:request': async (payload) => {
    const data = payload as { path?: string } | undefined
    return proxyApiRequest(data?.path ?? '')
  },

  'attachment:download': async (payload) => {
    const data = payload as { url?: string } | undefined
    return downloadAttachment(data?.url ?? '')
  },

  'archive:save': async (payload) => {
    const data = payload as { dataUrl?: string; filename?: string } | undefined
    return saveArchive(data?.dataUrl ?? '', data?.filename ?? 'archive.zip')
  },

  'worker:ping': () => ({ ok: true }),

  // content script 就绪：用于点图标时判断面板是否可切换
  'content:ready': () => ({ ok: true }),
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: unknown) => void) => {
  const typed = (message ?? {}) as Message
  const type = typeof typed.type === 'string' ? typed.type : ''
  const handler = handlers[type]

  if (!handler) return false

  void (async () => {
    try {
      sendResponse(await handler(typed.payload))
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()

  // 异步响应，保持通道开启
  return true
})

/**
 * 点击扩展图标 → 通知当前标签页切换面板。
 *
 * 用 action.onClicked 而非 popup：面板需要足够大的纵向空间，
 * 侧栏注入比 popup 合适。
 */
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return
  if (!tab.url?.startsWith('https://chat.deepseek.com/')) {
    return
  }
  void chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {
    // 内容脚本尚未注入（页面还在加载），静默忽略
  })
})