import type {
  Attachment,
  Conversation,
  Message,
  RawConversation,
  RawFile,
  RawFragment,
  RawMessage,
  RawSearchResult,
  RawSession,
  Role,
  SearchSource,
  Session,
} from './types'

/**
 * 附件存放在独立文件服务上，不在 chat.deepseek.com。
 * signed_path 返回的是该服务的相对路径，且签名有有效期——必须在导出当时下载。
 */
export const FILE_SERVICE_BASE = 'https://files.deepseeksvc.com/api'

/** 这些 fragment 不是正文，别混进 markdown */
const NON_CONTENT_FRAGMENTS = new Set(['THINK', 'TOOL_SEARCH', 'TOOL_OPEN', 'SEARCH', 'TIP', 'FILE'])

function fragmentType(fragment: RawFragment): string {
  return typeof fragment.type === 'string' ? fragment.type.toUpperCase() : ''
}

/**
 * 时间字段在接口里既可能是秒级 epoch 数字，也可能是数字字符串。
 * 统一成秒级数字，渲染层再决定怎么格式化。
 */
export function toEpochSeconds(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return toEpochSeconds(asNumber, fallback)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return fallback
}

function normalizeRole(role: unknown): Role {
  const value = typeof role === 'string' ? role.toUpperCase() : ''
  if (value === 'USER') return 'user'
  if (value === 'ASSISTANT') return 'assistant'
  if (value === 'SYSTEM') return 'system'
  return 'tool'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把 signed_path / url 变成可直接 fetch 的绝对地址。
 *
 * `/file?xxx` 属于独立文件服务，需要换域名。关键在 `ty` 参数——
 * 它是**必填**的，服务端只接受三个值（实测报错信息：
 * `ty: unknown variant 'o', expected one of 'p', 't', 'r'`）：
 *
 * | ty | 含义 | 适用 |
 * |----|------|------|
 * | p  | 预览 | 图片（网页端就这么取） |
 * | t  | 文本 | 部分文本类资源 |
 * | r  | 原始 | 文档（xlsx/json/txt/pdf…） |
 *
 * 早期版本对所有文件统一加 `ty=p`，结果文档类全部 400；不加 ty 又会报
 * `missing field 'ty'`。正确做法是按类型分流：图片 p，其余 r。
 */
export function resolveFileUrl(file: RawFile): string | null {
  const raw = typeof file.signed_path === 'string' && file.signed_path !== ''
    ? file.signed_path
    : typeof file.url === 'string' && file.url !== ''
      ? file.url
      : null

  if (!raw) return null
  if (raw.startsWith('data:')) return raw

  if (/^\/file(?:\?|$)/.test(raw)) {
    try {
      const url = new URL(`${FILE_SERVICE_BASE}${raw}`)
      if (!url.searchParams.has('ty')) {
        url.searchParams.set('ty', isImageFile(file) ? 'p' : 'r')
      }
      return url.href
    } catch {
      return raw
    }
  }

  try {
    return new URL(raw, 'https://chat.deepseek.com').href
  } catch {
    return raw
  }
}

function fileName(file: RawFile): string {
  return file.file_name || file.filename || file.name || 'attachment'
}

export function isImageFile(file: RawFile): boolean {
  if (file.is_image === true) return true
  const mime = typeof file.mime_type === 'string' ? file.mime_type : typeof file.mimetype === 'string' ? file.mimetype : ''
  if (mime.startsWith('image/')) return true
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(fileName(file))
}

function toAttachment(file: RawFile): Attachment {
  const mimeType = typeof file.mime_type === 'string'
    ? file.mime_type
    : typeof file.mimetype === 'string'
      ? file.mimetype
      : ''

  const attachment: Attachment = {
    fileName: fileName(file),
    mimeType,
    url: resolveFileUrl(file),
    isImage: isImageFile(file),
  }
  if (typeof file.width === 'number') attachment.width = file.width
  if (typeof file.height === 'number') attachment.height = file.height
  const size = typeof file.size === 'number' ? file.size : typeof file.file_size === 'number' ? file.file_size : undefined
  if (size !== undefined) attachment.size = size
  return attachment
}

/**
 * 附件可能挂两处：message.files，或 fragments 里 type=FILE 的 fragment。
 * 两处都要收，并按文件名+尺寸去重（同一附件偶尔会重复出现）。
 */
function collectAttachments(message: RawMessage): Attachment[] {
  const raw: RawFile[] = [...(message.files ?? [])]
  for (const fragment of message.fragments ?? []) {
    if (fragmentType(fragment) !== 'FILE') continue
    if (Array.isArray(fragment.files)) raw.push(...fragment.files)
    if (fragment.file && typeof fragment.file === 'object') raw.push(fragment.file)
  }

  const seen = new Set<string>()
  const attachments: Attachment[] = []
  for (const file of raw) {
    const attachment = toAttachment(file)
    const key = `${attachment.fileName}|${attachment.size ?? ''}|${attachment.url ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    attachments.push(attachment)
  }
  return attachments
}

/**
 * 正文提取。
 *
 * 用户消息只认 REQUEST，助手只认 RESPONSE / TEMPLATE_RESPONSE —— 这样能
 * 天然滤掉思考与工具片段。全都没有时退化为「所有非正文片段拼接」，
 * 避免某些新版 fragment 类型导致正文整段丢失。
 */
function visibleText(message: RawMessage): string {
  const role = normalizeRole(message.role)
  const fragments = message.fragments ?? []
  const accepted = role === 'user' ? new Set(['REQUEST']) : new Set(['RESPONSE', 'TEMPLATE_RESPONSE'])

  const parts = fragments
    .filter((fragment) => accepted.has(fragmentType(fragment)))
    .map((fragment) => textOf(fragment.content))
    .filter(Boolean)

  if (parts.length > 0) return parts.join('\n\n')
  if (typeof message.content === 'string' && message.content.trim() !== '') return message.content.trim()

  return fragments
    .filter((fragment) => !NON_CONTENT_FRAGMENTS.has(fragmentType(fragment)))
    .map((fragment) => textOf(fragment.content))
    .filter(Boolean)
    .join('\n\n')
}

function collectThinking(message: RawMessage): { texts: string[]; seconds?: number } {
  const texts: string[] = []
  let seconds = 0
  let hasSeconds = false

  for (const fragment of message.fragments ?? []) {
    if (fragmentType(fragment) !== 'THINK') continue
    const content = textOf(fragment.content)
    if (content) texts.push(content)
    if (typeof fragment.elapsed_secs === 'number' && Number.isFinite(fragment.elapsed_secs)) {
      seconds += fragment.elapsed_secs
      hasSeconds = true
    }
  }

  // 少数接口版本把思考放在消息顶层
  if (texts.length === 0) {
    const legacy = textOf((message as Record<string, unknown>).reasoning_content)
      || textOf((message as Record<string, unknown>).thinking_content)
    if (legacy) texts.push(legacy)
  }

  return hasSeconds ? { texts, seconds } : { texts }
}

/** 递归收集 fragment 里任何带 url 的对象，当作联网搜索来源 */
function collectSources(value: unknown, out: RawSearchResult[], visited: Set<unknown>): void {
  if (!value || typeof value !== 'object' || visited.has(value)) return
  visited.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, out, visited)
    return
  }

  const record = value as Record<string, unknown>
  if (typeof record.url === 'string' && record.url !== '') {
    out.push(record as RawSearchResult)
  }
  for (const key of ['results', 'result', 'queries']) {
    if (key in record) collectSources(record[key], out, visited)
  }
}

function collectionSources(message: RawMessage): SearchSource[] {
  const raw: RawSearchResult[] = []
  const visited = new Set<unknown>()
  for (const fragment of message.fragments ?? []) {
    const type = fragmentType(fragment)
    if (type !== 'TOOL_SEARCH' && type !== 'TOOL_OPEN' && type !== 'SEARCH') continue
    collectSources(fragment, raw, visited)
  }

  const sources: SearchSource[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const url = typeof item.url === 'string' ? item.url : ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    const source: SearchSource = {
      index: typeof item.cite_index === 'number'
        ? item.cite_index
        : typeof item.index === 'number'
          ? item.index
          : sources.length,
      title: textOf(item.title) || textOf(item.site_name) || url,
      url,
    }
    if (typeof item.site_name === 'string' && item.site_name !== '') source.siteName = item.site_name
    const snippet = textOf(item.snippet) || textOf(item.description)
    if (snippet) source.snippet = snippet
    sources.push(source)
  }
  return sources
}

function isHidden(message: RawMessage): boolean {
  const flag = (message as Record<string, unknown>).is_visually_hidden_from_conversation
  if (flag === true) return true
  const role = normalizeRole(message.role)
  return role !== 'user' && role !== 'assistant'
}

export function normalizeMessage(raw: RawMessage): Message {
  const thinking = collectThinking(raw)
  const message: Message = {
    id: String(raw.message_id),
    parentId: raw.parent_id == null ? null : String(raw.parent_id),
    role: normalizeRole(raw.role),
    text: visibleText(raw),
    thinking: thinking.texts,
    sources: collectionSources(raw),
    attachments: collectAttachments(raw),
    insertedAt: toEpochSeconds(raw.inserted_at, toEpochSeconds(raw.updated_at)),
    hidden: isHidden(raw),
  }
  if (thinking.seconds !== undefined) message.thinkingSeconds = thinking.seconds
  if (typeof raw.model === 'string' && raw.model !== '') message.model = raw.model
  if (typeof raw.status === 'string' && raw.status !== '') message.status = raw.status
  return message
}

export function normalizeSession(raw: RawSession): Session {
  const updatedAt = toEpochSeconds(raw.updated_at)
  const session: Session = {
    id: String(raw.id),
    title: textOf(raw.title) || '未命名对话',
    createdAt: toEpochSeconds(raw.inserted_at, updatedAt),
    updatedAt: updatedAt || toEpochSeconds(raw.inserted_at),
    pinned: Boolean(raw.pinned),
    currentMessageId: raw.current_message_id == null ? null : String(raw.current_message_id),
  }
  if (typeof raw.model_type === 'string' && raw.model_type !== '') session.modelType = raw.model_type
  return session
}

/**
 * 会话详情归一化。
 *
 * 注意 parent_id 可能指向本会话里不存在的消息（接口只回当前分支附近的
 * 部分历史时会这样），这种孤儿节点在构树时按根处理，不能直接丢掉。
 */
export function normalizeConversation(raw: RawConversation, fallbackId: string): Conversation {
  const messages = Array.isArray(raw.chat_messages)
    ? raw.chat_messages
    : Array.isArray(raw.messages)
      ? raw.messages
      : []

  const session = normalizeSession({ ...raw.chat_session, id: raw.chat_session?.id ?? fallbackId })

  const normalized = messages
    .filter((message) => message && message.message_id != null)
    .map(normalizeMessage)

  // 同一 message_id 重复出现时保留最后一条（接口分页拼接会产生重复）
  const byId = new Map<string, Message>()
  for (const message of normalized) byId.set(message.id, message)

  const deduped = [...byId.values()].sort((left, right) => left.insertedAt - right.insertedAt)

  if (session.currentMessageId && !byId.has(session.currentMessageId)) {
    session.currentMessageId = null
  }

  return { session, messages: deduped }
}

/** 只取导出要用的可见消息（隐藏的系统/提示消息剔除） */
export function visibleMessages(conversation: Conversation): Message[] {
  return conversation.messages.filter((message) => !message.hidden && (message.role === 'user' || message.role === 'assistant'))
}