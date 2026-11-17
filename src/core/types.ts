/**
 * DeepSeek 网页端接口的数据模型。
 *
 * 分两层：
 * - Raw*   —— 接口原样返回，字段全是可选的、命名有多种可能（官方改过字段名）
 * - Conversation / Message —— 归一化后的稳定模型，渲染层只认这一层
 *
 * 所有兼容处理集中在 normalize.ts，接口改版时只改那一处。
 */

/* ------------------------------------------------------------------ *
 * 原始层
 * ------------------------------------------------------------------ */

/** 附件。file_name / filename / name，signed_path / url 都出现过。 */
export interface RawFile {
  id?: string | number
  file_id?: string | number
  file_name?: string
  filename?: string
  name?: string
  /** 形如 `/file?...`，属于 files.deepseeksvc.com 域名，不是 chat.deepseek.com */
  signed_path?: string
  url?: string
  mime_type?: string
  mimetype?: string
  type?: string
  is_image?: boolean
  width?: number
  height?: number
  size?: number
  file_size?: number
  [key: string]: unknown
}

export interface RawSearchResult {
  title?: string
  url?: string
  snippet?: string
  description?: string
  site_name?: string
  cite_index?: number
  index?: number
  published_at?: string | number
  [key: string]: unknown
}

/**
 * 消息片段。这是 DeepSeek 数据结构里最核心的一层：
 * 一条消息的正文、思考、搜索、附件都拆在不同 type 的 fragment 里。
 */
export interface RawFragment {
  type?: string
  content?: string
  /** 思考耗时，秒 */
  elapsed_secs?: number
  queries?: unknown[]
  results?: RawSearchResult[]
  result?: RawSearchResult
  files?: RawFile[]
  file?: RawFile
  [key: string]: unknown
}

export interface RawMessage {
  message_id: string | number
  parent_id?: string | number | null
  role?: string
  model?: string
  thinking_enabled?: boolean
  status?: string
  inserted_at?: number | string
  updated_at?: number | string
  fragments?: RawFragment[]
  files?: RawFile[]
  content?: string
  [key: string]: unknown
}

export interface RawSession {
  id: string | number
  title?: string
  title_type?: string
  model_type?: string
  pinned?: boolean | number
  updated_at?: number | string
  inserted_at?: number | string
  seq_id?: number
  current_message_id?: string | number | null
  [key: string]: unknown
}

export interface RawConversation {
  chat_session: RawSession
  chat_messages?: RawMessage[]
  /** 旧版字段名，做个兜底 */
  messages?: RawMessage[]
}

export interface RawSessionPage {
  chat_sessions?: RawSession[]
  has_more?: boolean
}

/** 接口外层信封：{ code, msg, data: { biz_code, biz_msg, biz_data } } */
export interface ApiEnvelope<T> {
  code?: number | string
  msg?: string
  data?: {
    biz_code?: number | string
    biz_msg?: string
    biz_data?: T
  } | T
}

/* ------------------------------------------------------------------ *
 * 归一化层
 * ------------------------------------------------------------------ */

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Attachment {
  fileName: string
  mimeType: string
  /** 可直接下载的绝对地址；拿不到时为 null（仍会在文档里列出文件名） */
  url: string | null
  width?: number
  height?: number
  size?: number
  isImage: boolean
}

export interface SearchSource {
  index: number
  title: string
  url: string
  siteName?: string
  snippet?: string
}

export interface Message {
  id: string
  parentId: string | null
  role: Role
  /** 正文（REQUEST 或 RESPONSE 片段拼合） */
  text: string
  /** 思考过程；未开启深度思考时为空数组 */
  thinking: string[]
  /** 思考总耗时（秒），拿不到则 undefined */
  thinkingSeconds?: number
  /** 本消息触发的联网搜索来源 */
  sources: SearchSource[]
  /** 用户上传的附件 */
  attachments: Attachment[]
  /** 模型标识，如 deepseek-reasoner */
  model?: string
  insertedAt: number
  status?: string
  /** 页面不展示的内部消息（如提示条），导出时跳过 */
  hidden: boolean
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  modelType?: string
  /** 当前选中的叶子消息 id，决定 Markdown 走哪条线 */
  currentMessageId: string | null
}

export interface Conversation {
  session: Session
  /** 扁平存储的消息，靠 parentId 连成 n 叉树 */
  messages: Message[]
}

/** 渲染层要的一份「主线 + 分支」视图 */
export interface ConversationView {
  session: Session
  /** 从根到 currentMessageId 的激活路径，按时间正序 */
  activePath: Message[]
  /** parentId → 该父节点下的全部子节点 id（按时间正序） */
  childrenOf: Map<string, string[]>
  /** id → 消息 */
  byId: Map<string, Message>
  /** 分支统计：有多少个节点存在多个版本 */
  branchPoints: number
  /** 未被选中的分支消息总数 */
  orphanCount: number
}