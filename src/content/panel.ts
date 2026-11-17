import type { ApiRequester } from '../core/api'
import { fetchAllSessions } from '../core/api'
import { runExport, type ExportResult } from './exporter'
import type { Session } from '../core/types'
import { formatDateTime } from '../core/render/common'

/**
 * 归档面板。
 *
 * 用原生 DOM 而非框架：整个面板只有一个界面、几十个元素，引入框架的收益
 * 不抵它给扩展包带来的体积与 CSP 复杂度。
 *
 * 状态集中在一个对象里，渲染函数从状态读取，避免散落的 DOM 读写导致不一致。
 */

export interface PanelOptions {
  /** 复用已有请求器，避免每次导出都重建桥 */
  request: ApiRequester
  /**
   * 面板根节点。必须由调用方传入——面板挂在 Shadow DOM 里，
   * document.querySelector 查不到 shadow tree 内的元素。
   */
  root: HTMLElement
  onClose(): void
}

interface PanelState {
  sessions: Session[]
  selected: Set<string>
  filter: string
  phase: 'idle' | 'loading-list' | 'exporting' | 'done'
  connection: 'checking' | 'ok' | 'error'
}

const FORMAT_ORDER = ['md', 'docx', 'txt', 'json'] as const

function query<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`面板元素缺失：${selector}`)
  return element
}

export function mountPanel(options: PanelOptions): { destroy(): void } {
  const root = options.root
  const statusCard = query<HTMLElement>('#statusCard', root)
  const statusText = query<HTMLElement>('#statusText', root)
  const btnReload = query<HTMLButtonElement>('#btnReload', root)
  const sessionList = query<HTMLElement>('#sessionList', root)
  const sessionCount = query<HTMLElement>('#sessionCount', root)
  const sessionSearch = query<HTMLInputElement>('#sessionSearch', root)
  const btnSelectAll = query<HTMLButtonElement>('#btnSelectAll', root)
  const btnSelectNone = query<HTMLButtonElement>('#btnSelectNone', root)
  const progressCard = query<HTMLElement>('#progressCard', root)
  const progressLabel = query<HTMLElement>('#progressLabel', root)
  const progressCounter = query<HTMLElement>('#progressCounter', root)
  const progressBar = query<HTMLElement>('#progressBar', root)
  const progressBarWrap = query<HTMLElement>('#progressBarWrap', root)
  const resultCard = query<HTMLElement>('#resultCard', root)
  const resultTitle = query<HTMLElement>('#resultTitle', root)
  const resultStats = query<HTMLElement>('#resultStats', root)
  const errorDetails = query<HTMLDetailsElement>('#errorDetails', root)
  const errorList = query<HTMLUListElement>('#errorList', root)
  const btnExport = query<HTMLButtonElement>('#btnExport', root)
  const btnCancel = query<HTMLButtonElement>('#btnCancel', root)
  const btnClose = query<HTMLButtonElement>('#btnClose', root)
  const toast = query<HTMLElement>('#toast', root)

  const state: PanelState = {
    sessions: [],
    selected: new Set(),
    filter: '',
    phase: 'loading-list',
    connection: 'checking',
  }

  let abortController: AbortController | null = null
  let toastTimer: number | null = null
  let destroyed = false

  /* ---------------------------------------------------------------- *
   * Toast：失败与成功的唯一出口（不用 alert/confirm）
   * ---------------------------------------------------------------- */
  function showToast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toast.textContent = message
    toast.dataset.kind = kind
    toast.hidden = false
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
      toastTimer = null
    }, kind === 'error' ? 5000 : 2600)
  }

  function setConnection(next: PanelState['connection'], text: string): void {
    state.connection = next
    statusCard.dataset.state = next === 'ok' ? 'ok' : next === 'error' ? 'error' : 'warn'
    statusText.textContent = text
    btnReload.hidden = next !== 'error'
  }

  /* ---------------------------------------------------------------- *
   * 会话列表
   * ---------------------------------------------------------------- */
  function visibleSessions(): Session[] {
    const keyword = state.filter.trim().toLowerCase()
    if (keyword === '') return state.sessions
    return state.sessions.filter((session) => session.title.toLowerCase().includes(keyword))
  }

  function renderSessions(): void {
    const items = visibleSessions()
    sessionList.replaceChildren()

    if (state.phase === 'loading-list') {
      const skeleton = document.createElement('div')
      skeleton.className = 'ds-skeleton'
      for (let index = 0; index < 3; index += 1) {
        const row = document.createElement('div')
        row.className = 'ds-skeleton-row'
        skeleton.append(row)
      }
      sessionList.append(skeleton)
      sessionCount.textContent = '加载中'
      return
    }

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ds-list-empty'
      empty.textContent = state.sessions.length === 0
        ? '没有找到会话。确认已登录 DeepSeek 后刷新页面。'
        : `没有标题匹配“${state.filter}”的会话`
      sessionList.append(empty)
      sessionCount.textContent = state.sessions.length === 0 ? '0 个' : `0 / ${state.sessions.length}`
      return
    }

    const fragment = document.createDocumentFragment()
    for (const session of items) {
      const label = document.createElement('label')
      label.className = 'ds-item'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = state.selected.has(session.id)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(session.id)
        else state.selected.delete(session.id)
        updateFooter()
      })

      const body = document.createElement('div')
      body.className = 'ds-item-body'

      const title = document.createElement('span')
      title.className = 'ds-item-title'
      title.textContent = session.title
      title.title = session.title

      const meta = document.createElement('div')
      meta.className = 'ds-item-meta'
      const time = document.createElement('span')
      time.textContent = formatDateTime(session.updatedAt)
      meta.append(time)
      if (session.pinned) {
        const pin = document.createElement('span')
        pin.className = 'ds-item-flag'
        pin.textContent = '置顶'
        meta.append(pin)
      }

      body.append(title, meta)
      label.append(checkbox, body)
      fragment.append(label)
    }
    sessionList.append(fragment)
    sessionCount.textContent = `${state.selected.size} / ${state.sessions.length}`
  }

  function updateFooter(): void {
    const count = state.selected.size
    sessionCount.textContent = state.sessions.length === 0
      ? '0 个'
      : `${count} / ${state.sessions.length}`

    if (state.phase === 'exporting') {
      btnExport.disabled = true
      return
    }
    if (state.phase === 'done') {
      // 完成态保留「再次导出」文案，不被选择数覆盖
      btnExport.disabled = count === 0
      if (btnExport.textContent !== '再次导出') btnExport.textContent = '再次导出'
      return
    }
    btnExport.disabled = count === 0
    btnExport.textContent = count === 0 ? '请选择会话' : `导出 ${count} 个会话`
  }

  /* ---------------------------------------------------------------- *
   * 进度
   * ---------------------------------------------------------------- */
  function updateProgress(label: string, current: number, total: number): void {
    progressCard.hidden = false
    progressLabel.textContent = label
    progressCounter.textContent = total > 0 ? `${current} / ${total}` : ''
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 5
    progressBar.style.width = `${percent}%`
    progressBarWrap.setAttribute('aria-valuenow', String(percent))
  }

  /* ---------------------------------------------------------------- *
   * 结果
   * ---------------------------------------------------------------- */
  function renderResult(result: ExportResult): void {
    resultCard.hidden = false
    const { summary } = result

    resultTitle.textContent = summary.failed > 0 ? '导出完成（有未完成项）' : '导出完成'

    const rows: Array<[string, string, string?]> = [
      ['会话', `${summary.succeeded} / ${summary.sessions}`, summary.failed > 0 ? 'is-warn' : undefined],
      ['消息', String(summary.messages)],
      ['分叉点', String(summary.branchPoints)],
      ['附件', String(summary.attachments)],
    ]
    if (summary.attachmentFailures > 0) {
      rows.push(['附件未存', String(summary.attachmentFailures), 'is-danger'])
    }

    resultStats.replaceChildren()
    for (const [term, value, className] of rows) {
      const wrapper = document.createElement('div')
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = value
      if (className) dd.className = className
      wrapper.append(dt, dd)
      resultStats.append(wrapper)
    }

    if (result.errors.length > 0) {
      errorDetails.hidden = false
      errorList.replaceChildren()
      for (const error of result.errors) {
        const item = document.createElement('li')
        item.textContent = `${error.title}：${error.error}`
        errorList.append(item)
      }
    } else {
      errorDetails.hidden = true
    }
  }

  /* ---------------------------------------------------------------- *
   * 动作
   * ---------------------------------------------------------------- */
  function selectedFormats(): Array<typeof FORMAT_ORDER[number]> {
    const inputs = root.querySelectorAll<HTMLInputElement>('input[name="format"]')
    const chosen: Array<typeof FORMAT_ORDER[number]> = []
    for (const input of inputs) {
      if (!input.checked) continue
      const value = input.value
      if ((FORMAT_ORDER as readonly string[]).includes(value)) {
        chosen.push(value as typeof FORMAT_ORDER[number])
      }
    }
    return chosen
  }

  async function loadSessions(): Promise<void> {
    state.phase = 'loading-list'
    renderSessions()
    setConnection('checking', '正在获取会话列表…')

    try {
      const sessions = await fetchAllSessions(options.request)
      if (destroyed) return

      state.sessions = sessions
      // 默认全选：用户点「全部导出」是主场景
      state.selected = new Set(sessions.map((session) => session.id))
      state.phase = 'idle'
      renderSessions()
      updateFooter()
      setConnection('ok', `已连接 · 共 ${sessions.length} 个会话`)
    } catch (error) {
      if (destroyed) return
      state.phase = 'idle'
      state.sessions = []
      renderSessions()
      updateFooter()
      const message = error instanceof Error ? error.message : String(error)
      setConnection('error', message)
      showToast(message, 'error')
    }
  }

  function setExporting(active: boolean, nextPhase: PanelState['phase'] = 'idle'): void {
    state.phase = active ? 'exporting' : nextPhase
    btnCancel.hidden = !active
    if (active) {
      btnExport.disabled = true
      btnExport.replaceChildren()
      const spinner = document.createElement('span')
      spinner.className = 'ds-spinner'
      const text = document.createElement('span')
      text.textContent = '导出中…'
      btnExport.append(spinner, text)
    } else {
      btnExport.replaceChildren()
      updateFooter()
    }
  }

  async function startExport(): Promise<void> {
    const formats = selectedFormats()
    if (formats.length === 0) {
      showToast('至少要选一种文件格式', 'error')
      return
    }
    if (state.selected.size === 0) {
      showToast('请先选择要导出的会话', 'error')
      return
    }

    // 重置上一次的结果区
    resultCard.hidden = true
    errorDetails.hidden = true
    progressBar.style.width = '0%'

    abortController = new AbortController()
    setExporting(true)

    try {
      const result = await runExport(
        {
          request: options.request,
          signal: abortController.signal,
          onProgress: (progress) => {
            updateProgress(progress.label, progress.current, progress.total)
          },
        },
        {
          formats,
          includeThinking: query<HTMLInputElement>('#optThinking', root).checked,
          includeSources: query<HTMLInputElement>('#optSources', root).checked,
          includeBranches: query<HTMLInputElement>('#optBranches', root).checked,
          includeAttachments: query<HTMLInputElement>('#optAttachments', root).checked,
          sessionIds: [...state.selected],
        },
      )

      if (destroyed) return
      progressBar.style.width = '100%'
      updateProgress('正在保存文件…', 1, 1)

      // 交给 background 走 chrome.downloads，避免大文件在页面内存里再复制一份
      const dataUrl = await blobToDataUrl(result.blob)
      const saveResult = await chrome.runtime.sendMessage({
        type: 'archive:save',
        payload: { dataUrl, filename: result.filename },
      }) as { ok: boolean; error?: string } | undefined

      if (!saveResult?.ok) {
        throw new Error(saveResult?.error ?? '保存文件失败')
      }

      renderResult(result)
      showToast(`已导出 ${result.summary.succeeded} 个会话`, 'success')
      // 传入 done 让 updateFooter 走完成态分支，保留「再次导出」文案
      setExporting(false, 'done')
      // 导出结束后进度条没有意义了，收起以免和结果卡片混在一起
      progressCard.hidden = true
      btnExport.textContent = '再次导出'
      btnExport.disabled = false
    } catch (error) {
      if (destroyed) return
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = message === '已取消'
      setExporting(false)
      progressCard.hidden = true
      showToast(cancelled ? '已取消导出' : message, cancelled ? 'info' : 'error')
    } finally {
      abortController = null
    }
  }

  /** Blob → data URL。扩展环境里 FileReader 可用，比手写 base64 稳。 */
  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('打包结果读取失败'))
      reader.readAsDataURL(blob)
    })
  }

  /* ---------------------------------------------------------------- *
   * 事件绑定
   * ---------------------------------------------------------------- */
  const onSearch = (): void => {
    state.filter = sessionSearch.value
    renderSessions()
  }

  const onSelectAll = (): void => {
    // 只选中当前筛选可见的，符合"筛选后批量操作"的直觉
    for (const session of visibleSessions()) state.selected.add(session.id)
    renderSessions()
    updateFooter()
  }

  const onSelectNone = (): void => {
    for (const session of visibleSessions()) state.selected.delete(session.id)
    renderSessions()
    updateFooter()
  }

  const onExport = (): void => {
    void startExport()
  }

  const onCancel = (): void => {
    abortController?.abort()
  }

  const onReload = (): void => {
    window.location.reload()
  }

  const onKeydown = (event: KeyboardEvent): void => {
    // Esc 关闭面板；导出中先取消
    if (event.key !== 'Escape') return
    if (state.phase === 'exporting') {
      abortController?.abort()
      return
    }
    options.onClose()
  }

  sessionSearch.addEventListener('input', onSearch)
  btnSelectAll.addEventListener('click', onSelectAll)
  btnSelectNone.addEventListener('click', onSelectNone)
  btnExport.addEventListener('click', onExport)
  btnCancel.addEventListener('click', onCancel)
  btnReload.addEventListener('click', onReload)
  btnClose.addEventListener('click', () => options.onClose())
  root.addEventListener('keydown', onKeydown)

  // 面板挂上就算打开，先拉列表
  void loadSessions()

  return {
    destroy(): void {
      destroyed = true
      abortController?.abort()
      if (toastTimer !== null) window.clearTimeout(toastTimer)
      sessionSearch.removeEventListener('input', onSearch)
      btnSelectAll.removeEventListener('click', onSelectAll)
      btnSelectNone.removeEventListener('click', onSelectNone)
      btnExport.removeEventListener('click', onExport)
      btnCancel.removeEventListener('click', onCancel)
      btnReload.removeEventListener('click', onReload)
      root.removeEventListener('keydown', onKeydown)
    },
  }
}