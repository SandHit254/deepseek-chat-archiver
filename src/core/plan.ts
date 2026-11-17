import type { Attachment, Conversation, Session } from './types'

/**
 * 文件命名与目录规划。
 *
 * 踩过的坑：同名会话直接拼标题会互相覆盖（真实用户就有多个「新对话」）。
 * 所以统一用「序号 + 安全标题 + id 后缀」，三层保证唯一。
 */

/** 文件名里绝对不允许出现的字符（Windows 比 Unix 更严格） */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows 保留名，作为文件名会直接失败 */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

const MAX_TITLE_LENGTH = 60

/**
 * 把会话标题变成安全的文件名片段。
 *
 * 处理链：去非法字符 → 折叠空白 → 去尾部点号与空格（Windows 不允许）
 * → 避开保留名 → 截断。截断放在最后，且要重新去尾，否则可能又留个点。
 */
export function safeFileName(title: string, fallback = 'untitled'): string {
  let name = title
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')

  if (name === '') name = fallback
  if (RESERVED.test(name)) name = `_${name}`

  if (name.length > MAX_TITLE_LENGTH) {
    name = name.slice(0, MAX_TITLE_LENGTH).replace(/[. ]+$/, '')
    if (name === '') name = fallback
  }
  return name
}

/** 会话 id 取后 8 位做防重名后缀。id 可能很长，取尾部更随机。 */
export function shortId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '')
  return cleaned.slice(-8) || 'noid'
}

/** 会话目录名：03_标题_a1b2c3d4 */
export function sessionFolderName(index: number, session: Session): string {
  const order = String(index + 1).padStart(3, '0')
  return `${order}_${safeFileName(session.title)}_${shortId(session.id)}`
}

/** 附件文件名：001_diagram.png，序号保证同一目录内不重名 */
export function attachmentFileName(index: number, attachment: Attachment): string {
  const order = String(index + 1).padStart(3, '0')
  const name = attachment.fileName
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${order}_${safeFileName(base, 'file')}${ext.replace(ILLEGAL, '')}`
}

/** 导出批次根目录名：DeepSeek 归档 2026-12-01 */
export function batchFolderName(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `DeepSeek 归档 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export type ExportFormat = 'md' | 'txt' | 'docx' | 'json'

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  md: 'Markdown (.md)',
  txt: '纯文本 (.txt)',
  docx: 'Word (.docx)',
  json: '结构化 JSON (.json)',
}

export interface PlanOptions {
  formats: ExportFormat[]
  includeThinking: boolean
  includeSources: boolean
  includeBranches: boolean
  includeAttachments: boolean
}

export interface PlannedAttachment {
  attachment: Attachment
  /** 相对批次根目录的保存路径 */
  path: string
  messageId: string
}

export interface PlannedSession {
  session: Session
  /** 相对批次根目录的目录路径 */
  folder: string
  /** 相对批次根目录的文件路径，按格式索引 */
  files: Array<{ format: ExportFormat; path: string }>
  attachments: PlannedAttachment[]
}

/**
 * 规划一个会话的全部产物路径。
 *
 * 附件单独成目录并附 _manifest.json，是为了让「文件 ↔ 消息」的对应关系
 * 在脱离本工具后依然可查——纯把图片丢一个目录里等于丢失上下文。
 */
export function planSession(
  index: number,
  conversation: Conversation,
  options: PlanOptions,
): PlannedSession {
  const folder = sessionFolderName(index, conversation.session)
  const files = options.formats.map((format) => ({
    format,
    path: `${folder}/conversation.${format}`,
  }))

  const attachments: PlannedAttachment[] = []
  if (options.includeAttachments) {
    let counter = 0
    for (const message of conversation.messages) {
      for (const attachment of message.attachments) {
        // 拿不到下载地址的附件不占文件槽位，只会在文档里留文件名
        if (!attachment.url) continue
        attachments.push({
          attachment,
          path: `${folder}/attachments/${attachmentFileName(counter, attachment)}`,
          messageId: message.id,
        })
        counter += 1
      }
    }
  }

  return { session: conversation.session, folder, files, attachments }
}

/** 附件清单内容：谁在哪个消息里传了什么 */
export function attachmentManifest(planned: PlannedSession): string {
  return `${JSON.stringify(
    {
      sessionId: planned.session.id,
      title: planned.session.title,
      attachments: planned.attachments.map((item) => ({
        file: item.path.split('/').pop(),
        originalName: item.attachment.fileName,
        mimeType: item.attachment.mimeType,
        size: item.attachment.size ?? null,
        width: item.attachment.width ?? null,
        height: item.attachment.height ?? null,
        messageId: item.messageId,
        sourceUrl: item.attachment.url,
      })),
    },
    null,
    2,
  )}\n`
}