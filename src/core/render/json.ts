import type { Conversation, ConversationView, Message } from '../types'
import { collectBranchPoints, summarizeBranches } from '../tree'

/**
 * 结构化 JSON 导出。
 *
 * 这是「无损存档位」：完整保留 n 叉树、全部思考片段、搜索来源、附件元数据、
 * 未选中分支与消息父子关系。目标不是给人读，而是「以后能程序化还原」。
 *
 * 因此这里不做普通用户友好的裁剪——被选中/未选中都留，但用 active 字段
 * 标出来，方便下游程序知道哪条是主线。
 */

export interface JsonOptions {
  includeThinking: boolean
  includeSources: boolean
  includeAttachments: boolean
  /** 附件相对路径映射：messageId → 相对路径数组 */
  attachmentPaths?: Map<string, string[]>
  exportedAt?: Date
}

function serializeMessage(
  message: Message,
  view: ConversationView,
  options: JsonOptions,
): Record<string, unknown> {
  const children = view.childrenOf.get(message.id) ?? []
  const attachmentPaths = options.attachmentPaths?.get(message.id)

  const record: Record<string, unknown> = {
    id: message.id,
    parentId: message.parentId,
    role: message.role,
    active: view.activePath.some((item) => item.id === message.id),
    childIds: children,
    insertedAt: message.insertedAt,
  }

  if (message.model) record.model = message.model
  if (message.status) record.status = message.status
  record.text = message.text

  if (options.includeThinking && message.thinking.length > 0) {
    record.thinking = message.thinking
    if (message.thinkingSeconds !== undefined) record.thinkingSeconds = message.thinkingSeconds
  }

  if (options.includeSources && message.sources.length > 0) {
    record.sources = message.sources
  }

  if (options.includeAttachments && message.attachments.length > 0) {
    record.attachments = message.attachments.map((attachment, index) => ({
      ...attachment,
      savedAs: attachmentPaths?.[index] ?? null,
    }))
  }

  return record
}

/**
 * 完整树形结构。
 *
 * 同时输出两种视图，因为下游用途不同：
 * - messages：扁平数组 + parentId，适合程序化遍历（与接口格式一致，便于回灌）
 * - tree：嵌套 children 结构，适合人眼快速看懂分叉
 *
 * 冗余是刻意的：转换成本远低于让使用者自己写还原逻辑。
 */
export function renderJson(
  conversation: Conversation,
  view: ConversationView,
  options: JsonOptions,
): string {
  const summary = summarizeBranches(view)
  const branchPoints = collectBranchPoints(view, view.activePath)

  const messages = conversation.messages
    .filter((message) => !message.hidden)
    .map((message) => serializeMessage(message, view, options))

  const byId = new Map(conversation.messages.map((message) => [message.id, message]))

  type Node = Record<string, unknown>
  const buildTree = (id: string, visited: Set<string>): Node | null => {
    if (visited.has(id)) return null
    const message = byId.get(id)
    if (!message || message.hidden) return null
    visited.add(id)
    const childIds = view.childrenOf.get(id) ?? []
    const children = childIds
      .map((childId) => buildTree(childId, visited))
      .filter((node): node is Node => node !== null)
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      ...(options.includeThinking && message.thinking.length > 0 ? { thinking: message.thinking } : {}),
      children,
    }
  }

  const rootIds = conversation.messages
    .filter((message) => !message.hidden && (message.parentId == null || !byId.has(message.parentId)))
    .map((message) => message.id)
  const seen = new Set<string>()
  const tree = rootIds
    .map((id) => buildTree(id, seen))
    .filter((node): node is Node => node !== null)

  const payload = {
    format: 'deepseek-chat-archiver/v1',
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    session: {
      ...conversation.session,
      activeBranch: {
        messageIds: view.activePath.map((message) => message.id),
        messageCount: view.activePath.length,
      },
      branches: {
        points: summary.points,
        unselectedMessages: summary.messages,
        detail: branchPoints.map((point) => ({
          afterMessageId: point.parent?.id ?? null,
          versions: point.entries.map((entry) => ({
            rootId: entry.message.id,
            version: entry.version,
            of: entry.versionCount,
            continuation: entry.continuation.map((message) => message.id),
          })),
        })),
      },
    },
    messages,
    tree,
  }

  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 批次级 manifest：一批导出了哪些会话、各自多少消息、失败原因 */
export interface ManifestEntry {
  sessionId: string
  title: string
  folder: string | null
  messages: number
  branchPoints: number
  attachments: number
  error?: string
}

export function renderBatchManifest(entries: ManifestEntry[], options: { exportedAt: Date; formats: string[] }): string {
  const succeeded = entries.filter((entry) => !entry.error)
  const failed = entries.filter((entry) => entry.error)

  return `${JSON.stringify(
    {
      format: 'deepseek-chat-archiver/v1',
      exportedAt: options.exportedAt.toISOString(),
      formats: options.formats,
      summary: {
        total: entries.length,
        succeeded: succeeded.length,
        failed: failed.length,
        messages: succeeded.reduce((sum, entry) => sum + entry.messages, 0),
        attachments: succeeded.reduce((sum, entry) => sum + entry.attachments, 0),
        branchPoints: succeeded.reduce((sum, entry) => sum + entry.branchPoints, 0),
      },
      sessions: entries,
    },
    null,
    2,
  )}\n`
}