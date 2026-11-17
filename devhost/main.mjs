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
  /*
   * 触发面板打开。
   *
   * 时机很关键：content.js 里的 window 事件监听器是在
   * await waitForBridge()（最长 3 秒）之后才注册的，过早派发会被丢掉。
   * 而且 SPA 可能在这期间重渲染，把 host 冲掉。
   * 因此改成轮询：反复派发直到面板真的出现为止。
   */
  let attempts = 0
  const tryOpen = async () => {
    if (webContents.isDestroyed()) return
    attempts += 1
    try {
      // 用「打开」而不是「切换」：轮询时反复切换会让面板开了又关
      await webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('ds-archiver:open-panel')); true`,
        true,
      )
      await new Promise((resolve) => setTimeout(resolve, 500))

      const state = await probeState(webContents)
      // 面板已开且会话列表已就绪就停；否则继续重试（最多 20 次）
      const listLoaded = state.sessionItems > 0 || (state.statusText && state.statusText.includes('共'))
      if ((state.panelRendered && listLoaded) || attempts >= 20) {
        console.log('[devhost] 状态（打开面板后）：', JSON.stringify(state))
        const shotPath = join(app.getPath('temp'), 'ds-archiver-shot.png')
        const image = await webContents.capturePage()
        await writeFile(shotPath, image.toPNG())
        console.log(`[devhost] 截图已保存：${shotPath}`)

        // 列表就绪后，若开启了自动导出，则点一次「开始导出」
        if (listLoaded && process.argv.includes('--auto-export')) {
          await runExportFlow(webContents)
        }
        return
      }
      setTimeout(() => { void tryOpen() }, 800)
    } catch (error) {
      console.error('[devhost] 触发面板失败：', error instanceof Error ? error.message : String(error))
    }
  }
  setTimeout(() => { void tryOpen() }, 3500)
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

  // 顺便把 token 存储位置探出来，用于校准 pageHook 的兜底读取
  let tokenKeys = [];
  try {
    tokenKeys = Object.keys(localStorage).filter(k => /token|auth|user/i.test(k));
  } catch { /* 忽略 */ }

  // 直接验证 pageHook 内部的 token 读取链路是否通畅
  const chain = (() => {
    try {
      // 复制 pageHook 的解析逻辑，验证能否从 userToken 拿到干净 token
      const raw = localStorage.getItem('userToken');
      if (!raw) return { step: 'no-raw' };
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) return { step: 'plain', len: trimmed.length };
      const parsed = JSON.parse(trimmed);
      const v = parsed.value;
      if (typeof v === 'string') return { step: 'parsed-string', len: v.length, looksJwt: v.split('.').length === 3 };
      return { step: 'parsed-other', type: typeof v };
    } catch (e) {
      return { step: 'error', message: String(e) };
    }
  })();

  // 检查 sessionStorage 里有没有我们缓存过的 token
  const cached = (() => {
    try {
      const v = sessionStorage.getItem('__ds_archiver_token__');
      return v ? { present: true, len: v.length, preview: v.slice(0, 10) } : { present: false };
    } catch { return { present: false, error: 'blocked' }; }
  })();
  const tokenDiag = (() => {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return { present: false };
      const trimmed = raw.trim();
      const shape = trimmed.startsWith('{') ? 'json' : 'plain';
      let innerKeys = [];
      let valuePreview = null;
      if (shape === 'json') {
        const obj = JSON.parse(trimmed);
        innerKeys = Object.keys(obj);
        const v = obj.value;
        if (typeof v === 'string') valuePreview = v.slice(0, 12) + '...(len=' + v.length + ')';
        else if (v && typeof v === 'object') {
          innerKeys = innerKeys.concat('value.' + Object.keys(v).join(','));
          if (typeof v.value === 'string') valuePreview = v.value.slice(0, 12) + '...(len=' + v.value.length + ')';
        }
      } else {
        valuePreview = trimmed.slice(0, 12) + '...(len=' + trimmed.length + ')';
      }
      return { present: true, shape, innerKeys, valuePreview, rawLength: trimmed.length };
    } catch (e) {
      return { present: true, error: String(e) };
    }
  })();

  const tokenSample = (() => {
    try {
      for (const k of tokenKeys) {
        const v = localStorage.getItem(k);
        if (v && v.length > 10) {
          return { key: k, looksLikeJson: v.trim().startsWith('{'), length: v.length };
        }
      }
    } catch { /* 忽略 */ }
    return null;
  })();

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
    tokenKeys,
    tokenSample,
    tokenDiag,
    chain,
    cached,
  };
})()`

async function probeState(webContents) {
  try {
    return await webContents.executeJavaScript(PROBE_SOURCE, true)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 自动跑一遍导出流程。
 *
 * 只选前 2 个会话，避免一次导出 345 个把调试拖成几十分钟（每个会话之间
 * 有 800ms 限流间隔）。验证目标是链路通不通，不是跑满全量。
 */
async function runExportFlow(webContents) {
  console.log('\n[devhost] ===== 开始自动导出验证 =====')

  // 1. 只保留前两个会话，并开启全部格式
  const selected = await webContents.executeJavaScript(`(() => {
    const host = document.getElementById('ds-archiver-host');
    const root = host && host.shadowRoot;
    if (!root) return { ok: false, reason: '面板不存在' };

    const items = root.querySelectorAll('.ds-item input[type=checkbox]');
    // 取消所有勾选
    for (const box of items) {
      if (box.checked) box.click();
    }
    // 勾选前两个
    for (let i = 0; i < Math.min(2, items.length); i += 1) {
      items[i].click();
    }
    // 全选四种格式，验证 docx/json 链路
    for (const box of root.querySelectorAll('input[name=format]')) {
      if (!box.checked) box.click();
    }
    const formats = Array.from(root.querySelectorAll('input[name=format]')).map(b => b.value + ':' + b.checked);
    return {
      ok: true,
      total: items.length,
      checked: root.querySelector('#sessionCount')?.textContent,
      buttonText: root.querySelector('#btnExport')?.textContent,
      formats,
    };
  })()`, true)
  console.log('[devhost] 选择结果：', JSON.stringify(selected))

  if (!selected.ok) return

  // 2. 点击「开始导出」
  await webContents.executeJavaScript(`(() => {
    const host = document.getElementById('ds-archiver-host');
    const root = host && host.shadowRoot;
    const btn = root.querySelector('#btnExport');
    if (btn) btn.click();
    return true;
  })()`, true)

  // 3. 轮询进度，直到完成或超时
  const startedAt = Date.now()
  const timeoutMs = 5 * 60 * 1000
  let lastLabel = ''

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (webContents.isDestroyed()) return

    const progress = await webContents.executeJavaScript(`(() => {
      const host = document.getElementById('ds-archiver-host');
      const root = host && host.shadowRoot;
      if (!root) return { gone: true };
      return {
        label: root.querySelector('#progressLabel')?.textContent ?? '',
        counter: root.querySelector('#progressCounter')?.textContent ?? '',
        progressHidden: root.querySelector('#progressCard')?.hidden,
        resultHidden: root.querySelector('#resultCard')?.hidden,
        resultTitle: root.querySelector('#resultTitle')?.textContent ?? '',
        stats: root.querySelector('#resultStats')?.innerText ?? '',
        errors: Array.from(root.querySelectorAll('#errorList li')).map(li => li.textContent),
        toast: root.querySelector('#toast')?.hidden ? '' : (root.querySelector('#toast')?.textContent ?? ''),
      };
    })()`, true)

    if (progress.gone) {
      console.log('[devhost] 面板消失，可能页面重载')
      return
    }

    const label = `${progress.label} ${progress.counter} ${progress.toast}`
    if (label.trim() !== lastLabel.trim()) {
      lastLabel = label
      console.log(`[devhost] 进度：${progress.label} ${progress.counter} ${progress.toast ? `| toast: ${progress.toast}` : ''}`)
    }

    // 结果卡片出现 = 流程结束
    if (!progress.resultHidden) {
      console.log(`\n[devhost] ===== 导出完成：${progress.resultTitle} =====`)
      console.log('[devhost] 统计：')
      for (const line of progress.stats.split('\n')) {
        if (line.trim()) console.log(`  ${line}`)
      }
      if (progress.errors.length > 0) {
        console.log('[devhost] 未完成项：')
        for (const error of progress.errors) console.log(`  - ${error}`)
      }
      const shotPath = join(app.getPath('temp'), 'ds-archiver-result.png')
      const image = await webContents.capturePage()
      await writeFile(shotPath, image.toPNG())
      console.log(`[devhost] 结果截图：${shotPath}`)
      return
    }
  }

  console.log('[devhost] 导出超时（5 分钟）')
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

      /*
       * 自动化验证模式下不弹窗，直接写到临时目录。
       * 否则对话框会阻塞整条自动流程，无人值守就跑不下去。
       */
      const autoMode = process.argv.includes('--auto-export')
      let targetPath
      if (autoMode) {
        targetPath = join(app.getPath('temp'), filename)
      } else {
        const result = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('downloads'), filename),
          filters: [{ name: 'ZIP 归档', extensions: ['zip'] }],
        })
        if (result.canceled || !result.filePath) {
          return { ok: false, error: '已取消保存' }
        }
        targetPath = result.filePath
      }

      await writeFile(targetPath, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
      const stat = await readFile(targetPath).then((buffer) => buffer.length).catch(() => 0)
      console.log(`[devhost] 归档已保存：${targetPath}（${Math.round(stat / 1024)} KB）`)
      return { ok: true, path: targetPath }
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