import { zipSync, strToU8 } from 'fflate'
import {
  fetchAllConversations,
  fetchAllSessions,
  type ApiRequester,
  type BatchItem,
} from '../core/api'
import { buildConversationView, summarizeBranches } from '../core/tree'
import { renderMarkdown } from '../core/render/markdown'
import { renderText } from '../core/render/text'
import { renderJson, renderBatchManifest, type ManifestEntry } from '../core/render/json'
import { renderDocx } from '../core/render/docx'
import {
  attachmentManifest,
  batchFolderName,
  planSession,
  type ExportFormat,
  type PlanOptions,
  type PlannedSession,
} from '../core/plan'
import type { Conversation } from '../core/types'

/**
 * 导出编排：会话列表 → 详情 → 渲染 → 附件 → zip。
 *
 * 这一层负责"流程"，不负责"格式"：所有渲染细节都在 core/render 里，
 * 所有命名规则都在 core/plan 里。这样各层都能独立测试。
 */

export interface ExportOptions {
  formats: ExportFormat[]
  includeThinking: boolean
  includeSources: boolean
  includeBranches: boolean
  includeAttachments: boolean
  /** 只导出这些会话 id；为空表示全部 */
  sessionIds?: string[]
}

export interface ExportProgress {
  phase: 'listing' | 'fetching' | 'rendering' | 'attachments' | 'packing' | 'done'
  current: number
  total: number
  label: string
}

export interface ExportResult {
  blob: Blob
  filename: string
  summary: {
    sessions: number
    succeeded: number
    failed: number
    messages: number
    attachments: number
    attachmentFailures: number
    branchPoints: number
  }
  /** 单个会话的失败信息，供 UI 展示 */
  errors: Array<{ title: string; error: string }>
}

export interface ExportContext {
  request: ApiRequester
  onProgress?(progress: ExportProgress): void
  signal?: AbortSignal
}

/** 通过 background 下载附件，失败返回原因 */
async function downloadViaBackground(
  url: string,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'attachment:download',
      payload: { url },
    }) as { ok: boolean; dataUrl?: string; error?: string } | undefined

    if (!response) return { ok: false, error: '后台无响应，请重新加载扩展' }
    return response
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** data URL → Uint8Array，用于塞进 zip */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return new Uint8Array()
  const meta = dataUrl.slice(0, commaIndex)
  const body = dataUrl.slice(commaIndex + 1)

  if (meta.includes(';base64')) {
    const binary = atob(body)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  // 非 base64 的 data URL 是百分号编码的文本
  try {
    return new TextEncoder().encode(decodeURIComponent(body))
  } catch {
    return new TextEncoder().encode(body)
  }
}

/**
 * 为单个会话生成全部文件内容。
 *
 * 返回 files 时 key 是 zip 内路径（相对批次根目录），value 是字节内容。
 * docx 是二进制，其他都是 UTF-8 文本。
 */
async function renderSession(
  planned: PlannedSession,
  conversation: Conversation,
  planOptions: PlanOptions,
  pathsByMessage: Map<string, string[]>,
  exportedAt: Date,
): Promise<Record<string, Uint8Array>> {
  const view = buildConversationView(conversation)
  const files: Record<string, Uint8Array> = {}

  const renderOptions = {
    includeThinking: planOptions.includeThinking,
    includeSources: planOptions.includeSources,
    includeBranches: planOptions.includeBranches,
    includeAttachments: planOptions.includeAttachments,
    attachmentPaths: pathsByMessage,
    exportedAt,
  }

  for (const item of planned.files) {
    switch (item.format) {
      case 'md':
        files[item.path] = strToU8(renderMarkdown(view, renderOptions))
        break
      case 'txt':
        files[item.path] = strToU8(renderText(view, renderOptions))
        break
      case 'json':
        files[item.path] = strToU8(renderJson(conversation, view, {
          ...renderOptions,
        }))
        break
      case 'docx': {
        const blob = await renderDocx(view, {
          includeThinking: planOptions.includeThinking,
          includeSources: planOptions.includeSources,
          includeBranches: planOptions.includeBranches,
          includeAttachments: planOptions.includeAttachments,
          attachmentPaths: pathsByMessage,
        })
        files[item.path] = new Uint8Array(await blob.arrayBuffer())
        break
      }
    }
  }

  if (planOptions.includeAttachments && planned.attachments.length > 0) {
    files[`${planned.folder}/attachments/_manifest.json`] = strToU8(attachmentManifest(planned))
  }

  return files
}

/**
 * 主流程。
 *
 * 顺序刻意如此：先拿列表（失败就整体失败，快速暴露权限问题），
 * 再逐条拿详情（单条失败不影响整批），最后才是渲染与打包（纯本地计算）。
 */
export async function runExport(context: ExportContext, options: ExportOptions): Promise<ExportResult> {
  const { request, onProgress, signal } = context
  const exportedAt = new Date()
  const report = (progress: ExportProgress): void => {
    onProgress?.(progress)
  }

  report({ phase: 'listing', current: 0, total: 0, label: '正在获取会话列表…' })
  const allSessions = await fetchAllSessions(request, { signal })
  const sessions = options.sessionIds && options.sessionIds.length > 0
    ? allSessions.filter((session) => options.sessionIds!.includes(session.id))
    : allSessions

  if (sessions.length === 0) {
    throw new Error('没有找到可导出的会话')
  }

  report({ phase: 'fetching', current: 0, total: sessions.length, label: `共 ${sessions.length} 个会话，开始抓取…` })
  const items = await fetchAllConversations(request, sessions, {
    signal,
    progress: {
      onSession: (index, total, title) => {
        report({ phase: 'fetching', current: index + 1, total, label: `抓取 ${index + 1}/${total}：${title}` })
      },
    },
  })

  const planOptions: PlanOptions = {
    formats: options.formats,
    includeThinking: options.includeThinking,
    includeSources: options.includeSources,
    includeBranches: options.includeBranches,
    includeAttachments: options.includeAttachments,
  }

  const zipEntries: Record<string, Uint8Array> = {}
  const manifestEntries: ManifestEntry[] = []
  const errors: Array<{ title: string; error: string }> = []
  let attachmentFailures = 0
  let totalMessages = 0
  let totalAttachments = 0
  let totalBranchPoints = 0

  for (let index = 0; index < items.length; index += 1) {
    if (signal?.aborted) throw new Error('已取消')

    const item = items[index] as BatchItem
    const label = `${index + 1}/${items.length}：${item.session.title}`

    if (!item.conversation) {
      const error = item.error ?? '未知错误'
      errors.push({ title: item.session.title, error })
      manifestEntries.push({
        sessionId: item.session.id,
        title: item.session.title,
        folder: null,
        messages: 0,
        branchPoints: 0,
        attachments: 0,
        error,
      })
      continue
    }

    const conversation = item.conversation
    const planned = planSession(index, conversation, planOptions)
    const view = buildConversationView(conversation)

    // 附件路径映射：messageId → 相对路径，供文档引用
    const pathsByMessage = new Map<string, string[]>()
    for (const attachment of planned.attachments) {
      const list = pathsByMessage.get(attachment.messageId) ?? []
      list.push(attachment.path)
      pathsByMessage.set(attachment.messageId, list)
    }

    report({ phase: 'rendering', current: index + 1, total: items.length, label: `生成文档 ${label}` })
    const files = await renderSession(planned, conversation, planOptions, pathsByMessage, exportedAt)
    Object.assign(zipEntries, files)

    if (planOptions.includeAttachments) {
      for (let fileIndex = 0; fileIndex < planned.attachments.length; fileIndex += 1) {
        const attachment = planned.attachments[fileIndex]!
        report({
          phase: 'attachments',
          current: index + 1,
          total: items.length,
          label: `下载附件 ${label}（${fileIndex + 1}/${planned.attachments.length}）`,
        })

        if (!attachment.attachment.url) {
          attachmentFailures += 1
          continue
        }
        const result = await downloadViaBackground(attachment.attachment.url)
        if (result.ok && result.dataUrl) {
          zipEntries[attachment.path] = dataUrlToBytes(result.dataUrl)
          totalAttachments += 1
        } else {
          attachmentFailures += 1
          errors.push({
            title: item.session.title,
            error: `附件 ${attachment.attachment.fileName} 未能保存：${result.error ?? '未知原因'}`,
          })
        }
      }
    }

    totalMessages += view.activePath.length
    // 与正文附录保持一致：只统计沿主线的分叉点，不含分支内部的深层分叉
    totalBranchPoints += summarizeBranches(view).points
    manifestEntries.push({
      sessionId: item.session.id,
      title: item.session.title,
      folder: planned.folder,
      messages: view.activePath.length,
      branchPoints: summarizeBranches(view).points,
      attachments: planned.attachments.length,
    })
  }

  report({ phase: 'packing', current: 0, total: 0, label: '打包中…' })

  const batchFolder = batchFolderName(exportedAt)
  zipEntries[`${batchFolder}/manifest.json`] = strToU8(
    renderBatchManifest(manifestEntries, {
      exportedAt,
      formats: options.formats,
    }),
  )

  // level 6 是压缩率与速度的平衡点；9 在对话文本上收益很小但慢很多
  const zipped = zipSync(zipEntries, { level: 6 })
  const blob = new Blob([zipped as BlobPart], { type: 'application/zip' })

  const succeeded = manifestEntries.filter((entry) => !entry.error).length
  report({ phase: 'done', current: 1, total: 1, label: '完成' })

  return {
    blob,
    filename: `${batchFolder}.zip`,
    summary: {
      sessions: manifestEntries.length,
      succeeded,
      failed: manifestEntries.length - succeeded,
      messages: totalMessages,
      attachments: totalAttachments,
      attachmentFailures,
      branchPoints: totalBranchPoints,
    },
    errors,
  }
}