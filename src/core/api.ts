import { normalizeConversation, normalizeSession } from './normalize'
import type {
  ApiEnvelope,
  Conversation,
  RawConversation,
  RawSession,
  RawSessionPage,
  Session,
} from './types'

/**
 * DeepSeek 网页端只读接口封装。
 *
 * 设计要点：
 * 1. 不碰 PoW。create_pow_challenge 只作用于 /chat/completion 与 /file/upload_file，
 *    导出链路全是只读 GET，完全不需要解工作量证明。
 * 2. request 由外部注入（内容脚本用页面原生 fetch），这样可以脱离浏览器单测。
 * 3. 分页与风控逻辑全部收在这里，接口改版时只改本文件。
 */

export const API_BASE = 'https://chat.deepseek.com'

/** 会话列表分页大小。官方不带参数时也回全部，但带参数更可控。 */
const SESSION_PAGE_SIZE = 50

/** 单次批量导出的会话硬上限，防止分页停不下来时无限跑 */
const MAX_SESSION_COUNT = 20000

/**
 * yield 间隔：官方风控是「中等」，同 cookie 多机并发会被限。
 * 串行 + 每 N 个会话歇一下是最稳的做法。
 */
const SESSION_GAP_MS = 800
const SESSION_GAP_EVERY = 5

export class DeepSeekApiError extends Error {
  readonly status?: number
  readonly code?: number | string

  constructor(message: string, options: { status?: number; code?: number | string } = {}) {
    super(message)
    this.name = 'DeepSeekApiError'
    if (options.status !== undefined) this.status = options.status
    if (options.code !== undefined) this.code = options.code
  }
}

export interface RequestOptions {
  signal?: AbortSignal
}

/** 注入的请求函数：给路径，返回已解析的 JSON 信封 */
export type ApiRequester = (path: string, options?: RequestOptions) => Promise<ApiEnvelope<unknown>>

export interface ProgressReporter {
  onSessionList?(count: number): void
  onSession?(index: number, total: number, title: string): void
}

/**
 * 从信封里掏出 biz_data。
 *
 * 业务错误码藏在 data.biz_code 里，HTTP 200 也可能是失败，必须显式检查。
 * 40003 表示 token 失效，需要提示用户刷新页面重新嗅探。
 */
function unwrap<T>(envelope: ApiEnvelope<T>, context: string): T {
  if (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== '0') {
    throw new DeepSeekApiError(`${context}失败：${envelope.msg || `code ${envelope.code}`}`, { code: envelope.code })
  }

  const data = envelope.data
  if (data && typeof data === 'object' && 'biz_code' in data) {
    const bizCode = (data as { biz_code?: number | string }).biz_code
    // biz_code 为 0 才算成功；部分接口不返回该字段
    if (bizCode !== undefined && bizCode !== 0 && bizCode !== '0') {
      const bizMsg = (data as { biz_msg?: string }).biz_msg
      if (String(bizCode) === '40003') {
        throw new DeepSeekApiError('登录态已失效，请刷新 DeepSeek 页面后重试', { code: bizCode })
      }
      throw new DeepSeekApiError(`${context}失败：${bizMsg || `biz_code ${bizCode}`}`, { code: bizCode })
    }
    return (data as { biz_data?: T }).biz_data as T
  }
  return data as T
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ *
 * 会话列表
 * ------------------------------------------------------------------ */

interface FetchPageResult {
  sessions: Session[]
  hasMore: boolean
}

/**
 * 取一页会话列表。
 *
 * 这里踩过一个已知的坑：官方改过 fetch_page 的分页行为，带分页参数时
 * 只回前 50 条且 has_more 恒为 true，光看 has_more 会死循环。对策是让
 * 调用方用「游标签名是否推进 + 是否有新数据」判断终止，而不是只信 has_more。
 */
async function fetchSessionPage(
  request: ApiRequester,
  cursor: { pinned: number; updatedAt: number } | null,
  options: RequestOptions,
): Promise<FetchPageResult> {
  const query = new URLSearchParams()
  query.set('count', String(SESSION_PAGE_SIZE))
  if (cursor) {
    query.set('lte_cursor.pinned', String(cursor.pinned))
    query.set('lte_cursor.updated_at', String(cursor.updatedAt))
  }

  const path = `/api/v0/chat_session/fetch_page?${query.toString()}`
  const bizData = unwrap(await request(path, options), '获取会话列表') as RawSessionPage | undefined
  const rawSessions = Array.isArray(bizData?.chat_sessions) ? bizData.chat_sessions : []

  return {
    sessions: rawSessions.map((session: RawSession) => normalizeSession(session)),
    hasMore: Boolean(bizData?.has_more),
  }
}

/**
 * 拉取全部会话列表。
 *
 * 三层终止条件，缺一不可：
 *   1. hasMore 为 false
 *   2. 游标没有推进（官方 has_more 恒 true 时的兜底）
 *   3. 本页没有带来任何新会话（去重后为空）
 * 再加一个数量硬上限兜底。
 */
export async function fetchAllSessions(
  request: ApiRequester,
  options: RequestOptions & { progress?: ProgressReporter } = {},
): Promise<Session[]> {
  const sessions: Session[] = []
  const seen = new Set<string>()
  let cursor: { pinned: number; updatedAt: number } | null = null
  let lastSignature = ''

  for (let page = 0; page < MAX_SESSION_COUNT; page += 1) {
    const result = await fetchSessionPage(request, cursor, options)

    let novel = 0
    for (const session of result.sessions) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
      novel += 1
    }
    options.progress?.onSessionList?.(sessions.length)

    if (result.sessions.length === 0 || novel === 0) break
    if (!result.hasMore) break

    const last = result.sessions[result.sessions.length - 1]!
    const nextCursor = { pinned: last.pinned ? 1 : 0, updatedAt: last.updatedAt }
    const signature = `${nextCursor.pinned}:${nextCursor.updatedAt}`
    if (signature === lastSignature) break
    lastSignature = signature
    cursor = nextCursor
  }

  return sessions
}

/* ------------------------------------------------------------------ *
 * 单会话详情
 * ------------------------------------------------------------------ */

export async function fetchConversation(
  request: ApiRequester,
  sessionId: string,
  options: RequestOptions = {},
): Promise<Conversation> {
  const path = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`
  const bizData = unwrap(await request(path, options), '获取对话内容') as RawConversation | undefined
  if (!bizData || !bizData.chat_session) {
    throw new DeepSeekApiError('对话内容为空，可能是会话已被删除或无权访问')
  }
  return normalizeConversation(bizData, sessionId)
}

/* ------------------------------------------------------------------ *
 * 批量
 * ------------------------------------------------------------------ */

export interface BatchItem {
  session: Session
  conversation?: Conversation
  error?: string
}

/**
 * 串行拉取全部会话详情。
 *
 * 串行不是保守，是必须：官方对同一 cookie 的并发请求敏感。
 * 单个会话失败不中断整批——存档工具的价值在于「尽量多存」，
 * 一次风控就把整批废掉是不可接受的。
 */
export async function fetchAllConversations(
  request: ApiRequester,
  sessions: Session[],
  options: RequestOptions & {
    progress?: ProgressReporter
    onItem?(item: BatchItem, index: number, total: number): void
  } = {},
): Promise<BatchItem[]> {
  const items: BatchItem[] = []

  for (let index = 0; index < sessions.length; index += 1) {
    if (options.signal?.aborted) throw new Error('已取消')

    const session = sessions[index]!
    options.progress?.onSession?.(index, sessions.length, session.title)

    let item: BatchItem
    try {
      const conversation = await fetchConversation(request, session.id, options)
      item = { session, conversation }
    } catch (error) {
      // 取消要向上传递，其他错误记录下来继续下一个
      if (options.signal?.aborted) throw error
      item = { session, error: error instanceof Error ? error.message : String(error) }
    }

    items.push(item)
    options.onItem?.(item, index, sessions.length)

    if ((index + 1) % SESSION_GAP_EVERY === 0 && index + 1 < sessions.length) {
      await sleep(SESSION_GAP_MS, options.signal)
    }
  }

  return items
}