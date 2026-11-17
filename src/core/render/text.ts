import type { ConversationView, Message } from '../types'
import type { BranchPoint } from '../tree'
import { collectBranchPoints, summarizeBranches } from '../tree'
import { formatDateTime, formatDuration, roleLabel, sessionSummaryLines } from './common'

/**
 * 纯文本渲染。
 *
 * Markdown 语法在 txt 里是噪音（`**`、`#`、`<details>`），所以这里把
 * 结构改成「等宽分隔线 + 缩进」，任何编辑器打开都可读。
 * 代码块用缩进 4 空格保留，并且不做强制换行，避免破坏代码。
 */

export interface TextOptions {
  includeThinking: boolean
  includeSources: boolean
  includeBranches: boolean
  includeAttachments: boolean
  attachmentPaths?: Map<string, string[]>
}

const LINE = '='.repeat(72)
const THIN = '-'.repeat(72)
const INDENT = '    '

function indent(text: string, prefix = INDENT): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${prefix}${line}`))
    .join('\n')
}

function renderMessage(message: Message, options: TextOptions): string {
  const parts: string[] = []
  parts.push(THIN)
  const meta: string[] = [roleLabel(message.role), formatDateTime(message.insertedAt)]
  if (message.model) meta.push(message.model)
  parts.push(`[${meta.join(' | ')}]`)
  parts.push('')

  if (options.includeThinking && message.thinking.length > 0) {
    const seconds = formatDuration(message.thinkingSeconds)
    parts.push(`【深度思考${seconds ? ` · 耗时 ${seconds}` : ''}】`)
    parts.push(indent(message.thinking.join('\n\n')))
    parts.push('')
  }

  parts.push(message.text)
  parts.push('')

  if (options.includeSources && message.sources.length > 0) {
    parts.push('【参考来源】')
    for (const source of message.sources) {
      const site = source.siteName ? `（${source.siteName}）` : ''
      parts.push(`${INDENT}[${source.index + 1}] ${source.title}${site}`)
      parts.push(`${INDENT}${' '.repeat(4)}${source.url}`)
    }
    parts.push('')
  }

  if (options.includeAttachments && message.attachments.length > 0) {
    const paths = options.attachmentPaths?.get(message.id) ?? []
    parts.push('【附件】')
    for (const attachment of message.attachments) {
      const relative = paths.find((path) => path.includes(attachment.fileName))
      parts.push(`${INDENT}- ${attachment.fileName}${relative ? ` → ${relative}` : '（未下载）'}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

function renderBranchPoint(point: BranchPoint, index: number, options: TextOptions, depth = 0): string {
  const parts: string[] = []
  const marker = '#'.repeat(depth + 1)
  const where = point.parent
    ? `接在 ${roleLabel(point.parent.role)} · ${formatDateTime(point.parent.insertedAt)} 之后`
    : '会话开头'
  parts.push(`${marker} 分支点 ${index + 1}：${where}`)
  parts.push('')

  for (const entry of point.entries) {
    parts.push(`${marker}# 版本 ${entry.version} / ${entry.versionCount}`)
    parts.push('')
    for (const message of entry.continuation) {
      if (options.includeThinking && message.thinking.length > 0) {
        parts.push('【深度思考】')
        parts.push(indent(message.thinking.join('\n\n')))
        parts.push('')
      }
      parts.push(message.text)
      parts.push('')
    }
    for (const deeper of entry.deeper) {
      parts.push(renderBranchPoint(deeper, 0, options, depth + 1))
    }
  }
  return parts.join('\n')
}

export function renderText(view: ConversationView, options: TextOptions): string {
  const session = view.session
  const points = options.includeBranches ? collectBranchPoints(view, view.activePath) : []
  const summary = summarizeBranches(view)

  const parts: string[] = []
  parts.push(LINE)
  parts.push(session.title)
  parts.push(LINE)
  for (const line of sessionSummaryLines(view, summary.points, summary.messages)) {
    parts.push(line)
  }
  parts.push('')

  for (const message of view.activePath) {
    parts.push(renderMessage(message, options))
  }

  if (options.includeBranches && points.length > 0) {
    parts.push(LINE)
    parts.push('附录：未选中的分支')
    parts.push(LINE)
    parts.push('以下为「重新生成」或「编辑后重发」产生的历史版本，未被选中。')
    parts.push('')
    points.forEach((point, index) => {
      parts.push(renderBranchPoint(point, index, options))
    })
  }

  return `${parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`
}