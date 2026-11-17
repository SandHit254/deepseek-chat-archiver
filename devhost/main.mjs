import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * DeepSeek Chat Archiver 的调试宿主。
 *
 * 解决的问题：MV3 扩展侧载到 Chrome 后，开发者看不到真实运行情况，
 * 只能靠用户截图和贴日志。这个宿主把同样的脚本注入真实页面，本地就能
 * 跑通整条链路并看到控制台。
 *
 * 关键设计：
 * - 加载真实的 chat.deepseek.com（不是 mock），因此登录态、WAF Cookie、
 *   身份头、SPA 行为全部是真环境
 * - pageHook 与 content.js 用 executeJavaScript 注入页面主世界，
 *   与扩展里 web_accessible_resources + script 标签的效果一致
 * - 提供最小 chrome.runtime 桩（preload），只实现扩展真正用到的那几个 API
 *
 * 注意：这是调试工具，不是发布形态。真实分发仍用 MV3 扩展。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(__dirname, '../dist')
const TARGET_URL = 'https://chat.deepseek.com/'

/** token 只留在主进程内存，不写盘 */
let tokenCache = ''

async function readDist(file) {
  return await readFile(join(DIST, file), 'utf8')
}

/**
 * 把 preload 暴露的桩合并成页面世界可用的 chrome.runtime。
 *
 * 为什么需要这一步：contextBridge 暴露的对象挂在 __dsArchiverStub__ 上，
 * 而 content.js 期待 window.chrome.runtime。Chromium 页面自带一个只读的
 * window.chrome（含 loadTimes 等），不能整体覆盖，只能修补 runtime 属性。
 */
const BOOTSTRAP_STUB = `(() => {
  const stub = window.__dsArchiverStub__;
  if (!stub) return { ok: false, reason: '__dsArchiverStub__ 不可见' };

  const existing = window.chrome || {};
  try {
    // 优先修补已有对象，避免与内核自带的 chrome 冲突
    Object.defineProperty(existing, 'runtime', {
      value: stub.runtime,
      configurable: true,
      writable: true,
    });
    window.chrome = existing;
  } catch {
    // 若 chrome 被定义为只读，整体赋值兜底
    try { window.chrome = { ...existing, runtime: stub.runtime }; } catch { /* 放弃 */ }
  }

  // 调试宿主用 DOM 事件模拟「点扩展图标」，把事件转给 onMessage 的监听器
  if (!window.__dsArchiverToggleBound) {
    window.__dsArchiverToggleBound = true;
    window.addEventListener('ds-archiver:toggle-panel', () => {
      for (const handler of stub.runtime.onMessage.listeners) {
        try { handler({ type: 'toggle-panel' }, null, () => {}); } catch { /* 忽略 */ }
      }
    });
  }

  return { ok: true, hasRuntime: !!(window.chrome && window.chrome.runtime) };
})()`

/**
 * 注入顺序很重要：
 *   1. 先把 chrome 桩合并到页面世界（content.js 依赖它）
 *   2. pageHook 挂 fetch/XHR 钩子与代发通道
 *   3. content.js 最后跑，此时前两者都已就绪
 */
async function injectExtension(webContents) {
  const pageHook = await readDist('pageHook.js')
  const content = await readDist('content.js')

  const ready = await webContents.executeJavaScript(
    `({
      url: location.href,
      hasBody: !!document.body,
      // 判断 executor 到底跑在哪个世界：主世界能看到页面自己的变量，
      // 隔离世界则是一个干净环境
      hasPageVars: typeof window.__NEXT_DATA__ !== 'undefined'
        || typeof window.__remixContext !== 'undefined'
        || Object.keys(window).some(k => k.startsWith('__')),
      canSeeDocumentTitle: document.title !== '',
    })`,
    true,
  )
  console.log('[devhost] 执行世界探测：', JSON.stringify(ready))
  if (!ready.hasBody) {
    console.log('[devhost] 页面尚无 body，跳过本次注入')
    return
  }

  const stub = await webContents.executeJavaScript(BOOTSTRAP_STUB, true)
  if (!stub.ok) {
    console.error(`[devhost] chrome 桩不可用：${stub.reason}`)
    return
  }

  await webContents.executeJavaScript(pageHook, true)

  try {
    await webContents.executeJavaScript(content, true)
    console.log(`[devhost] 注入完成（${ready.url}）`)
  } catch (error) {
    console.error('[devhost] content.js 注入抛错：', error instanceof Error ? error.message : String(error))
    return
  }

  // 注入完立即探测一次，把状态打到终端。这是调试宿主的核心价值所在：
  // 不用截图、不用贴日志，命令行就能看到面板到底处于什么状态。
  const immediate = await probeState(webContents)
  console.log('[devhost] 状态（注入后）：', JSON.stringify(immediate))

  /*
   * 触发面板打开。
   *
   * 时机很关键：content.js 里的 window 事件监听器是在
   * await waitForBridge()（最长 3 秒）之后才注册的，过早派发会被丢掉。
   * 这里等 4 秒再派发，并再探测一次确认结果。
   */
  setTimeout(async () => {
    if (webContents.isDestroyed()) return
    try {
      await webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('ds-archiver:toggle-panel')); true`,
        true,
      )
      await new Promise((resolve) => setTimeout(resolve, 600))
      const after = await probeState(webContents)
      console.log('[devhost] 状态（打开面板后）：', JSON.stringify(after))

      // 自动截图：直接看真实渲染结果，比读 DOM 状态更可靠
      const shotPath = join(app.getPath('temp'), 'ds-archiver-shot.png')
      const image = await webContents.capturePage()
      await writeFile(shotPath, image.toPNG())
      console.log(`[devhost] 截图已保存：${shotPath}`)
    } catch (error) {
      console.error('[devhost] 触发面板失败：', error instanceof Error ? error.message : String(error))
    }
  }, 4000)
}

/**
 * 注入状态探测脚本。
 *
 * 判断 fetch 是否被改写不能用函数名——构建时会被压缩改名。
 * 可靠做法是看 toString 里是否还有 native code 标记。
 */
const PROBE_SOURCE = `(() => {
  const host = document.getElementById('ds-archiver-host');
  const root = host && host.shadowRoot;
  const fetchPatched = !String(window.fetch).includes('[native code]');
  return {
    url: location.href,
    pageHookInjected: fetchPatched,
    hostCreated: !!host,
    panelRendered: !!(root && root.querySelector('#ds-archiver-panel')),
    statusText: root ? (root.querySelector('#statusText')?.textContent ?? null) : null,
    sessionItems: root ? root.querySelectorAll('.ds-item').length : 0,
    exportButtonText: root ? (root.querySelector('#btnExport')?.textContent ?? null) : null,
    cssVarApplied: host ? getComputedStyle(host).getPropertyValue('--ds-primary').trim() : null,
    hasToken: (() => { try { return !!sessionStorage.getItem('__ds_archiver_token__'); } catch { return false; } })(),
  };
})()`

async function probeState(webContents) {
  try {
    return await webContents.executeJavaScript(PROBE_SOURCE, true)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function createWindow({ openDevTools }) {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'DeepSeek Chat Archiver · 调试宿主',
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 调试宿主需要模拟扩展的隔离世界行为，但为简化我们让脚本直接跑主世界，
      // 因此关闭沙箱以保证 executeJavaScript 的可靠性
      sandbox: false,
    },
  })

  win.webContents.on('did-finish-load', () => {
    void injectExtension(win.webContents).catch((error) => {
      console.error('[devhost] 注入失败：', error)
    })
  })

  // SPA 路由切换不会触发 did-finish-load，用 did-navigate-in-page 补注入
  win.webContents.on('did-navigate-in-page', () => {
    void injectExtension(win.webContents).catch(() => {
      // 重复注入由 pageHook 内部标记与 content.js 的 host 检查兜住
    })
  })

  win.webContents.on('console-message', (event, level, message) => {
    // 把页面控制台转发到终端，便于命令行观察
    const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] ?? 'LOG'
    if (tag === 'ERROR' || tag === 'WARN') {
      console.log(`[page:${tag}] ${message}`)
    }
  })

  if (openDevTools) win.webContents.openDevTools({ mode: 'right' })

  void win.loadURL(TARGET_URL)
  return win
}

app.whenReady().then(() => {
  const openDevTools = process.argv.includes('--devtools')

  /* ---------------------------------------------------------------- *
   * 扩展运行时桩：实现 content.js 用到的 chrome.runtime API
   * ---------------------------------------------------------------- */
  ipcMain.handle('ext:message', async (_event, message) => {
    const type = message?.type
    const payload = message?.payload ?? {}

    if (type === 'auth:token') {
      tokenCache = payload.token ?? ''
      return { ok: true }
    }

    if (type === 'auth:status') {
      return { ok: true, hasToken: tokenCache !== '' }
    }

    if (type === 'content:ready') {
      return { ok: true }
    }

    if (type === 'worker:ping') {
      return { ok: true }
    }

    /*
     * attachment:download —— 用 session.fetch 下载，自动带上该会话的 Cookie。
     * 这一点与扩展里的 background 等价（host_permissions 让扩展也能带 cookie），
     * 是附件能下下来的关键。
     */
    if (type === 'attachment:download') {
      const url = payload.url
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
        return { ok: false, error: '附件地址不合法' }
      }
      try {
        const response = await session.defaultSession.fetch(url)
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
        if (contentType.startsWith('text/html')) {
          return { ok: false, error: '附件链接已失效（签名可能过期）' }
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        const dataUrl = `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}`
        return { ok: true, dataUrl, mimeType: contentType, byteLength: buffer.byteLength }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /* archive:save —— 弹保存框写盘 */
    if (type === 'archive:save') {
      const dataUrl = payload.dataUrl ?? ''
      const filename = payload.filename ?? 'archive.zip'
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return { ok: false, error: '归档数据格式不正确' }

      const result = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('downloads'), filename),
        filters: [{ name: 'ZIP 归档', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, error: '已取消保存' }
      }
      await writeFile(result.filePath, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
      console.log(`[devhost] 归档已保存：${result.filePath}`)
      return { ok: true, path: result.filePath }
    }

    return { ok: false, error: `未实现的调用：${String(type)}` }
  })

  const win = createWindow({ openDevTools })

  /*
   * 提供一个快捷键来触发「点扩展图标」的效果：
   * Ctrl+Shift+D 切换面板。
   *
   * 不经过 chrome.runtime 的消息通道，而是直接在页面里派发 DOM 事件，
   * 由 content.js 注册的 window 监听器接住——这样不依赖 onMessage 的
   * 注册时机，调试时更可靠。
   */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'd') {
      event.preventDefault()
      void win.webContents
        .executeJavaScript(
          `window.dispatchEvent(new CustomEvent('ds-archiver:toggle-panel')); true`,
          true,
        )
        .catch(() => undefined)
    }
  })

  // 首次注入后自动打开面板，并打印注入状态，方便命令行观察
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      if (win.isDestroyed()) return
      await win.webContents
        .executeJavaScript(`window.dispatchEvent(new CustomEvent('ds-archiver:toggle-panel')); true`, true)
        .catch(() => undefined)

      const state = await probeState(win.webContents)
      console.log('\n===== 注入状态 =====')
      console.log(JSON.stringify(state, null, 2))
      console.log('====================\n')
    }, 3000)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})