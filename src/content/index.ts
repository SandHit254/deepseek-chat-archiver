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

    // 挂载失败必须让用户看见。否则面板会停在「正在检测登录状态…」，
    // 界面上毫无线索——早期版本就是这样静默失效的。
    try {
      teardown = mountPanel({
        request: createBackgroundRequester(),
        // 面板在 Shadow DOM 内，必须把根节点传进去
        root: wrapper,
        onClose: () => closePanel(),
      }).destroy
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[DeepSeek Archiver] 面板挂载失败', error)
      reportFatal(wrapper, message)
    }
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

/**
 * 面板自身出故障时的兜底提示。
 *
 * 直接在面板区域里渲染错误，而不是只往控制台打日志——用户不会去翻
 * 控制台，看到的只是一个永远停在「正在检测登录状态」的空壳。
 */
function reportFatal(root: HTMLElement, message: string): void {
  const body = root.querySelector<HTMLElement>('.ds-body')
  const target = body ?? root
  target.replaceChildren()

  const box = document.createElement('section')
  box.className = 'ds-card'

  const title = document.createElement('h2')
  title.className = 'ds-card-title'
  title.textContent = '面板加载失败'

  const detail = document.createElement('p')
  detail.style.margin = '8px 0 0'
  detail.style.fontSize = '12px'
  detail.style.color = '#64748b'
  detail.style.wordBreak = 'break-word'
  detail.textContent = message

  const hint = document.createElement('p')
  hint.style.margin = '8px 0 0'
  hint.style.fontSize = '12px'
  hint.style.color = '#64748b'
  hint.textContent = '刷新页面后重试；若持续失败，请在扩展管理页重新加载扩展。'

  box.append(title, detail, hint)
  target.append(box)

  const footer = root.querySelector<HTMLElement>('.ds-footer')
  footer?.replaceChildren()
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