import type { ConversationView, Message, Attachment } from '../types'
import type { BranchEntry, BranchPoint } from '../tree'
import { collectBranchPoints, summarizeBranches } from '../tree'

/**
 * Markdown 渲染。
 *
 * 结构决策（对应「主线 + 附录 + 无损 JSON」方案）：
 * - 正文只走激活路径，保证可读
 * - 遇到分支点插一行轻量提示，指向附录
 * - 思考过程用 <details> 折叠：GitHub / Obsidian / VS Code 都原生支持，
 *   展开就是全文，收起时不干扰阅读
 * - 文末附录按分叉点分组列出未选中分支
 *
 * 附件用小节列出并指向相对路径，同时保留原始文件名——这样 zip 解开后
 * 打开 md 就能看到「这条消息带了哪张图」，而不只是一堆孤立文件。
 */

export interface RenderOptions {
  includeThinking: boolean
  includeSources: boolean
  includeBranches: boolean
  includeAttachments: boolean
  /** 附件相对路径映射：messageId → 附件相对路径数组，与 plan 的结果对齐 */
  attachmentPaths?: Map<string, string[]>
  /** 批次生成时间，写进 YAML frontmatter */
  exportedAt?: Date
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateTime(epochSeconds: number): string {
  if (!epochSeconds) return '未知时间'
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) return '未知时间'
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} `
    + `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/** YAML frontmatter 的值需要转义，标题里带冒号/引号很常见 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function roleLabel(role: Message['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'system') return '系统'
  return '工具'
}

/**
 * 引用角标转成可点击链接。
 *
 * DeepSeek 正文里用的是 [reference:0] 这种相对序号，必须结合 sources 才能
 * 还原成真实 URL，否则导出后就成了一堆无意义的标记。
 */
function linkCitations(text: string, message: Message): string {
  if (message.sources.length === 0) return text
  return text.replace(/\[reference:(\d+)\]/g, (match, rawIndex: string) => {
    const wanted = Number(rawIndex)
    const source = message.sources.find((item) => item.index === wanted)
      ?? message.sources[wanted]
    if (!source) return match
    return `[${wanted + 1}](${source.url})`
  })
}

function renderThinking(message: Message, options: RenderOptions): string {
  if (!options.includeThinking || message.thinking.length === 0) return ''
  const duration = formatDuration(message.thinkingSeconds)
  const summary = duration ? `深度思考（${duration}）` : '深度思考'
  const body = message.thinking.join('\n\n')
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function renderSources(message: Message, options: RenderOptions): string {
  if (!options.includeSources || message.sources.length === 0) return ''
  const lines = message.sources.map((source) => {
    const site = source.siteName ? `${source.siteName} · ` : ''
    return `${source.index + 1}. ${site}[${source.title}](${source.url})`
  })
  return `**参考来源**\n\n${lines.join('\n')}`
}

function renderAttachments(message: Message, options: RenderOptions): string {
  if (!options.includeAttachments || message.attachments.length === 0) return ''

  const paths = options.attachmentPaths?.get(message.id) ?? []
  const lines = message.attachments.map((attachment: Attachment) => {
    // 按原始文件名匹配到计划里的路径，拿不到就退化为纯文件名
    const relative = paths.find((path) => path.includes(attachment.fileName))
    const label = attachment.fileName
    if (relative) return `- [${label}](${encodeURI(relative)})`
    return `- ${label}（未下载，原因见导出日志）`
  })
  return `**附件**\n\n${lines.join('\n')}`
}

function renderMessage(message: Message, options: RenderOptions): string {
  // 每个块都自带完整内容（不含首尾空行），最后统一用一个空行连接，
  // 这样不会出现「两块之间隔两个空行」或「相邻块粘连」两类问题。
  const blocks: string[] = []
  blocks.push(`## ${roleLabel(message.role)}`)

  const meta: string[] = []
  const time = formatDateTime(message.insertedAt)
  if (time !== '未知时间') meta.push(time)
  if (message.model) meta.push(`模型 \`${message.model}\``)
  if (meta.length > 0) blocks.push(`> ${meta.join(' · ')}`)

  if (options.includeThinking) {
    const thinking = renderThinking(message, options)
    if (thinking !== '') blocks.push(thinking)
  }

  const text = linkCitations(message.text, message)
  if (text !== '') blocks.push(text)

  const sources = renderSources(message, options)
  if (sources !== '') blocks.push(sources)

  const attachments = renderAttachments(message, options)
  if (attachments !== '') blocks.push(attachments)

  return blocks.join('\n\n')
}

function renderBranchHint(point: BranchPoint, anchorId: string): string {
  const count = point.entries.length
  const list = point.entries.map((entry) => `版本 ${entry.version}`).join('、')
  // 标题写作「## 分支点 1」，锚点要对应去掉空格的形式
  return `> 此处另有 ${count} 个未选中版本（${list}），见 [附录：分支点 ${anchorId}](#分支点-${anchorId})`
}

function renderBranchEntry(entry: BranchEntry, options: RenderOptions, depth: number): string {
  const heading = '#'.repeat(Math.min(6, depth + 3))
  const blocks: string[] = []
  blocks.push(`${heading} 版本 ${entry.version} / ${entry.versionCount}：${roleLabel(entry.message.role)}`)
  blocks.push(`> ${formatDateTime(entry.message.insertedAt)}`)

  // 只输出该分支独有的消息，共享前缀已在主线里
  for (const message of entry.continuation) {
    if (options.includeThinking) {
      const thinking = renderThinking(message, options)
      if (thinking !== '') blocks.push(thinking)
    }
    const text = linkCitations(message.text, message)
    if (text !== '') blocks.push(text)
    const sources = renderSources(message, options)
    if (sources !== '') blocks.push(sources)
    const attachments = renderAttachments(message, options)
    if (attachments !== '') blocks.push(attachments)
  }

  for (const deeper of entry.deeper) {
    blocks.push(`${heading}# 更深分支（接在 ${deeper.parent ? formatDateTime(deeper.parent.insertedAt) : '会话开头'} 之后）`)
    for (const inner of deeper.entries) {
      blocks.push(renderBranchEntry(inner, options, depth + 1))
    }
  }

  return blocks.join('\n\n')
}

function renderAppendix(points: BranchPoint[], options: RenderOptions): string {
  if (!options.includeBranches || points.length === 0) return ''

  const blocks: string[] = []
  blocks.push('# 附录：未选中的分支')
  blocks.push('> 以下内容为「重新生成」或「编辑后重发」产生的历史版本，未被选中，未出现在正文中。')

  points.forEach((point, index) => {
    const where = point.parent
      ? `接在 ${roleLabel(point.parent.role)} · ${formatDateTime(point.parent.insertedAt)} 之后`
      : '会话开头'
    blocks.push(`## 分支点 ${index + 1}`)
    blocks.push(`${where}，共 ${point.entries.length} 个未选中版本。`)
    for (const entry of point.entries) {
      blocks.push(renderBranchEntry(entry, options, 0))
    }
  })

  return blocks.join('\n\n')
}

/**
 * 建「主线索引 → 分叉点」映射。
 *
 * 分叉点是「某父节点下存在多个子节点」，而主线只走了其中一个。所以提示
 * 应插在该选中版本之后，即父节点在主线索引 +1 的位置。父节点不在主线
 * 上的分叉点（深层分支内部的）只出现在附录，不插正文提示。
 */
/** 建「主线索引 → 分叉点」映射。 */
function branchHintsByPathIndex(view: ConversationView, points: BranchPoint[]): Map<number, { point: BranchPoint; anchorId: string }> {
  const hints = new Map<number, { point: BranchPoint; anchorId: string }>()
  points.forEach((point, index) => {
    const anchorId = String(index + 1)
    if (!point.parent) {
      // 会话开头就分叉：提示放在最前面
      hints.set(-1, { point, anchorId })
      return
    }
    const parentIndex = view.activePath.findIndex((message) => message.id === point.parent!.id)
    if (parentIndex < 0) return
    hints.set(parentIndex, { point, anchorId })
  })
  return hints
}

/**
 * 渲染完整 Markdown 文档。
 *
 * @param view 会话视图（含激活路径与分支信息）
 * @param options 勾选项
 */
export function renderMarkdown(view: ConversationView, options: RenderOptions): string {
  const session = view.session
  const points = options.includeBranches ? collectBranchPoints(view, view.activePath) : []
  const summary = summarizeBranches(view)
  const hints = branchHintsByPathIndex(view, points)

  const lines: string[] = []
  lines.push('---')
  lines.push(`title: ${yamlString(session.title)}`)
  lines.push(`session_id: ${yamlString(session.id)}`)
  if (session.modelType) lines.push(`model: ${yamlString(session.modelType)}`)
  lines.push(`created: ${yamlString(formatDateTime(session.createdAt))}`)
  lines.push(`updated: ${yamlString(formatDateTime(session.updatedAt))}`)
  lines.push(`messages: ${view.activePath.length}`)
  if (options.includeBranches) lines.push(`branch_points: ${summary.points}`)
  if (options.exportedAt) lines.push(`exported_at: ${yamlString(formatDateTime(options.exportedAt.getTime() / 1000))}`)
  lines.push('---')
  lines.push('')

  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`> 共 ${view.activePath.length} 条消息 · 创建于 ${formatDateTime(session.createdAt)}`)
  if (options.includeBranches && summary.points > 0) {
    lines.push(`> 本对话有 ${summary.points} 处分叉，共 ${summary.messages} 条未选中分支，见文末附录。`)
  }
  lines.push('')

  const opening = hints.get(-1)
  if (opening) {
    lines.push(renderBranchHint(opening.point, opening.anchorId))
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  view.activePath.forEach((message, index) => {
    lines.push(renderMessage(message, options))
    const hint = hints.get(index)
    if (hint) {
      lines.push('')
      lines.push(renderBranchHint(hint.point, hint.anchorId))
    }
    // 消息之间留出两行空白，否则相邻的 ## 标题会贴在一起
    lines.push('')
  })

  const appendix = renderAppendix(points, options)
  if (appendix !== '') {
    lines.push('---')
    lines.push('')
    lines.push(appendix)
  }

  // 折叠 3 行以上的空行，保留段落之间必需的空行
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}