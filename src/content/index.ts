import { createBackgroundRequester } from './requester'
import { mountPanel } from './panel'
import { injectPageHook, relayTokenUpdates, waitForBridge } from './bridge'

/**
 * 内容脚本入口。
 *
 * 流程：
 *   1. 注入主世界钩子，嗅探 Authorization 并转交 background
 *   2. 点击扩展图标 → 在页面右侧挂载面板
 *
 * 面板放在 Shadow DOM 里而不是 iframe：DeepSeek 是 SPA，全局 CSS 与路由
 * 切换都很活跃，Shadow DOM 能隔离样式，又不必处理跨上下文的消息转发。
 */

const HOST_ID = 'ds-archiver-host'
const PANEL_WIDTH = 380
const TRANSITION_MS = 200

let host: HTMLElement | null = null
let teardown: (() => void) | null = null
let isOpen = false

function panelMarkup(): string {
  return `${__PANEL_HTML__}`
}

function panelStyles(): string {
  return `${__PANEL_CSS__}`
}

function buildHost(): HTMLElement {
  const container = document.createElement('div')
  container.id = HOST_ID

  // fixed 覆盖层而非改页面布局：不动宿主 DOM 结构，风险最低
  Object.assign(container.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    width: `${PANEL_WIDTH}px`,
    height: '100vh',
    zIndex: '2147483000',
    boxShadow: '-4px 0 24px rgba(15, 23, 42, 0.12)',
    borderLeft: '1px solid #e2e8f0',
    background: '#f0f2f5',
    transition: `transform ${TRANSITION_MS}ms ease`,
    transform: 'translateX(100%)',
    display: 'flex',
  } satisfies Partial<CSSStyleDeclaration>)

  return container
}

function openPanel(): void {
  if (!host) {
    host = buildHost()
    const shadow = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = panelStyles()

    const wrapper = document.createElement('div')
    wrapper.id = 'ds-archiver-panel'
    wrapper.innerHTML = panelMarkup()

    // 关掉面板时释放监听，避免重复挂载造成多次请求
    wrapper.addEventListener('ds-archiver:request-close', () => closePanel())

    shadow.append(style, wrapper)
    document.body.append(host)

    void chrome.runtime.sendMessage({ type: 'auth:status' }).then((status) => {
      const hasToken = (status as { hasToken?: boolean } | undefined)?.hasToken
      if (!hasToken) {
        console.warn('[DeepSeek Archiver] background 尚未持有 token')
      }
    }).catch(() => {
      // background 未就绪，忽略
    })

    teardown = mountPanel({
      request: createBackgroundRequester(),
      onClose: () => closePanel(),
    }).destroy
  }

  isOpen = true
  // 强制一次 reflow，否则从 display:none 到 transform 过渡不会生效
  void host.offsetWidth
  host.style.transform = 'translateX(0)'
}

function closePanel(): void {
  if (!host) return
  isOpen = false
  host.style.transform = 'translateX(100%)'
  const current = host
  window.setTimeout(() => {
    if (isOpen || !current.isConnected) return
    teardown?.()
    teardown = null
    current.remove()
    if (host === current) host = null
  }, TRANSITION_MS)
}

function togglePanel(): void {
  if (isOpen) closePanel()
  else openPanel()
}

/** SPA 路由切换可能重建 body，把面板补回来 */
function watchBody(): void {
  const observer = new MutationObserver(() => {
    if (host && !document.body.contains(host)) {
      teardown?.()
      teardown = null
      host = null
      isOpen = false
    }
  })
  observer.observe(document.body, { childList: true })
}

async function bootstrap(): Promise<void> {
  injectPageHook()

  const token = await waitForBridge()
  if (token !== '') {
    await chrome.runtime.sendMessage({ type: 'auth:token', payload: { token } }).catch(() => undefined)
  } else {
    console.warn('[DeepSeek Archiver] 暂未捕获到登录凭证；刷新页面或发一条消息后再试')
  }

  // 持续转发 token 刷新，保证长导出不中断
  relayTokenUpdates()

  // 扩展图标点击 → 切换面板
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const data = message as { type?: string } | null
    if (data?.type === 'toggle-panel') togglePanel()
    return false
  })

  watchBody()
  void chrome.runtime.sendMessage({ type: 'content:ready' }).catch(() => undefined)
}

export { openPanel, closePanel }

void bootstrap()