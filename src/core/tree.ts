import type { Conversation, ConversationView, Message } from './types'

/**
 * 分支相关的全部逻辑。
 *
 * 接口返回的 chat_messages 是「扁平存储的 n 叉树」：每条消息带 parent_id，
 * 用户每次「重新生成」或「编辑后重发」都会在同一父节点下新增一个兄弟节点，
 * chat_session.current_message_id 指向当前选中的那个叶子。
 *
 * 因此一个会话同时包含：
 *   - 一条激活路径（从根到 current_message_id）—— 用户实际看到的那条线
 *   - 若干条未选中分支 —— 曾经生成过、被弃用的内容
 *
 * 这里提供两件事：
 *   1. 还原激活路径
 *   2. 把未选中分支整理成「按分叉点分组的增量片段」，供附录渲染
 */

/* ------------------------------------------------------------------ *
 * 视图构建
 * ------------------------------------------------------------------ */

/**
 * 找到消息在「可见树上」真正的父节点。
 *
 * 两个必须处理的边界：
 * - 父节点被标记 hidden（例如页面不展示的提示条）：跳过它，接到更上层，
 *   否则整条子树会因为中间有个隐藏节点而断开。
 * - 父节点 id 在本会话里根本不存在（接口只回了部分历史）：按根处理，
 *   不能丢消息，否则就是静默丢数据。
 */
function attachableParent(message: Message, byId: Map<string, Message>): string | null {
  let parentId = message.parentId
  const visited = new Set<string>()

  while (parentId != null && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) return null
    if (!parent.hidden) return parentId
    parentId = parent.parentId
  }
  return null
}

/** 只要用户和助手的消息，系统消息与隐藏消息都不进文档 */
function isRenderable(message: Message): boolean {
  return !message.hidden && (message.role === 'user' || message.role === 'assistant')
}

/** 按插入时间正序，时间相同则按 id 稳定排序，保证多次导出结果一致 */
function sortByTime(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => {
    if (left.insertedAt !== right.insertedAt) return left.insertedAt - right.insertedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * 选择「默认叶子」：从某个节点往下，每步取最新的可见子节点，走到叶子。
 *
 * 用于确定一条未选中分支自己的主线——分支内部如果又分叉了，
 * 取最近生成的那条作为该分支的代表，其余作为更深层的分支。
 */
function defaultPathFrom(startId: string, childrenOf: Map<string, string[]>, byId: Map<string, Message>): Message[] {
  const path: Message[] = []
  const visited = new Set<string>()
  let currentId: string | null = startId

  while (currentId != null && !visited.has(currentId)) {
    visited.add(currentId)
    const message = byId.get(currentId)
    if (!message) break
    if (message.role === 'user' || message.role === 'assistant') path.push(message)
    const children: string[] = childrenOf.get(currentId) ?? []
    currentId = children.length > 0 ? children[children.length - 1]! : null
  }
  return path
}

export function buildConversationView(conversation: Conversation): ConversationView {
  const byId = new Map<string, Message>()
  for (const message of conversation.messages) byId.set(message.id, message)

  // 建立父子关系（只连可见消息，隐藏节点被跳过）
  const childrenOf = new Map<string, string[]>()
  const roots: Message[] = []
  for (const message of conversation.messages) {
    if (!isRenderable(message)) continue
    const parentId = attachableParent(message, byId)
    if (parentId == null) {
      roots.push(message)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(message.id)
    else childrenOf.set(parentId, [message.id])
  }

  // 子节点按时间排序，分支版本序号才有意义
  for (const [parentId, children] of childrenOf) {
    childrenOf.set(parentId, sortByTime(children.map((id) => byId.get(id)!)).map((message) => message.id))
  }
  const sortedRoots = sortByTime(roots)

  const activePath = resolveActivePath(conversation, byId, childrenOf, sortedRoots)

  const pathIds = new Set(activePath.map((message) => message.id))
  const renderable = conversation.messages.filter(isRenderable)

  let branchPoints = 0
  for (const children of childrenOf.values()) {
    if (children.length > 1) branchPoints += 1
  }
  if (sortedRoots.length > 1) branchPoints += 1

  return {
    session: conversation.session,
    activePath,
    childrenOf,
    byId,
    branchPoints,
    orphanCount: renderable.filter((message) => !pathIds.has(message.id)).length,
  }
}

/**
 * 还原激活路径。
 *
 * 首选 chat_session.current_message_id 回溯——这是唯一权威的「用户当前看到哪条」。
 * 兜底策略按可靠性排序：
 *   1. current_message_id 不在本次返回里（接口只回部分历史）→ 退到最深的最晚叶子
 *   2. 完全没有 current_message_id → 同上
 *
 * 气泡里还要防环：接口数据异常时 parent 链可能自引用。
 */
function resolveActivePath(
  conversation: Conversation,
  byId: Map<string, Message>,
  childrenOf: Map<string, string[]>,
  roots: Message[],
): Message[] {
  const currentId = conversation.session.currentMessageId
  let mainline: Message[] = []

  if (currentId != null && byId.has(currentId)) {
    const path: Message[] = []
    const visited = new Set<string>()
    let cursor: string | null = currentId

    while (cursor != null && !visited.has(cursor)) {
      visited.add(cursor)
      const message = byId.get(cursor)
      if (!message) break
      if (isRenderable(message)) path.push(message)
      cursor = attachableParent(message, byId)
    }

    if (path.length > 0) mainline = path.reverse()
  }

  // 补偿：current_message_id 若指向中间节点（而非叶子），它后面还有消息。
  // 真实数据里 current 应当是叶子，但接口偶尔落后一步。这里继续往下取最新的
  // 可见子节点，否则会静默丢掉后半段对话——存档工具不能这样。
  if (mainline.length > 0) {
    const lastMessage = mainline[mainline.length - 1]!
    const tail = defaultPathFrom(lastMessage.id, childrenOf, byId)
    // defaultPathFrom 的第一项就是 lastMessage 本身，跳过它
    if (tail.length > 1) mainline = [...mainline, ...tail.slice(1)]
  }

  if (mainline.length === 0) {
    // 兜底：在所有叶子中取「最深，其次最晚」的一条
    const leaves = [...byId.values()].filter(
      (message) => isRenderable(message) && (childrenOf.get(message.id) ?? []).length === 0,
    )
    const candidates = leaves.length > 0
      ? leaves
      : roots.length > 0
        ? roots
        : conversation.messages.filter(isRenderable)

    let best: Message | null = null
    let bestDepth = -1
    for (const candidate of candidates) {
      const depth = depthOf(candidate, byId)
      if (depth > bestDepth || (depth === bestDepth && best != null && candidate.insertedAt >= best.insertedAt)) {
        best = candidate
        bestDepth = depth
      }
    }
    if (!best) return []

    const path: Message[] = []
    const visited = new Set<string>()
    let cursor: Message | null = best
    while (cursor != null) {
      if (visited.has(cursor.id)) break
      visited.add(cursor.id)
      if (isRenderable(cursor)) path.push(cursor)
      const parentId = attachableParent(cursor, byId)
      cursor = parentId == null ? null : byId.get(parentId) ?? null
    }
    mainline = path.reverse()
  }

  // 游离链补偿：把不在主线上、又自成根的历史段落接回主线。
  //
  // 为什么必须有这一步：接口偶尔只返回会话的部分历史，某些消息的 parent_id
  // 指向本次未返回的消息，它们就成了「孤根」。若直接忽略，用户会静默丢掉
  // 整段历史——存档工具绝不能这样。这些段落按时间前置于主线，因为被截断的
  // 通常是最早的部分。
  const mainlineIds = new Set(mainline.map((message) => message.id))
  const strayRoots = roots
    .filter((root) => !mainlineIds.has(root.id))
    .filter((root) => !mainlineIds.has(attachableParent(root, byId) ?? ''))

  if (strayRoots.length === 0) return mainline

  const strayChains: Message[][] = sortByTime(strayRoots).map((root) => defaultPathFrom(root.id, childrenOf, byId))
  const stitched: Message[] = []
  const stitchedIds = new Set<string>()
  for (const chain of strayChains) {
    for (const message of chain) {
      if (mainlineIds.has(message.id) || stitchedIds.has(message.id)) continue
      stitchedIds.add(message.id)
      stitched.push(message)
    }
  }
  return [...stitched, ...mainline]
}

function depthOf(message: Message, byId: Map<string, Message>): number {
  let depth = 0
  const visited = new Set<string>()
  let cursor: Message | null = message
  while (cursor != null && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    const parentId = attachableParent(cursor, byId)
    cursor = parentId == null ? null : byId.get(parentId) ?? null
    depth += 1
  }
  return depth
}

/* ------------------------------------------------------------------ *
 * 未选中分支
 * ------------------------------------------------------------------ */

export interface BranchEntry {
  /** 该分支的第一条消息（未被选中的那个兄弟节点） */
  message: Message
  /** 这是第几个版本（1-based），以及总共有几个版本 */
  version: number
  versionCount: number
  /** 该分支自己的主线：从 message 往下取最新子节点走到叶子 */
  continuation: Message[]
  /** 这条分支内部更深的分叉 */
  deeper: BranchPoint[]
}

export interface BranchPoint {
  /** 分叉挂在哪个消息之后；null 表示从会话开头就分叉了 */
  parent: Message | null
  /** 该父节点下的全部分支（均未被选中） */
  entries: BranchEntry[]
}

/**
 * 收集一段主线沿途所有「未选中分支」。
 *
 * @param mainline 当前所选的主线
 * @param startIndex 从第几个元素开始检查兄弟分叉。检查 continuation 时传 1，
 *                   因为 continuation[0] 自身就是分支根，它和主线的兄弟关系
 *                   已经在外层记录过了，不重复记。
 *
 * 返回的是「增量」：每个条目只包含该分支独有的内容，不含与主线共享的前缀。
 * 这样附录体积不会随对话长度爆炸。
 */
export function collectBranchPoints(view: ConversationView, mainline: Message[], startIndex = 0): BranchPoint[] {
  const points: BranchPoint[] = []

  for (let index = startIndex; index < mainline.length; index += 1) {
    const message = mainline[index]!
    const parentId = attachableParent(message, view.byId)
    const siblingIds = parentId == null
      ? rootIdsOf(view)
      : view.childrenOf.get(parentId) ?? []

    const others = siblingIds.filter((id) => id !== message.id)
    if (others.length === 0) continue

    const entries: BranchEntry[] = others.map((id) => {
      const sibling = view.byId.get(id)!
      const continuation = defaultPathFrom(id, view.childrenOf, view.byId)
      return {
        message: sibling,
        version: siblingIds.indexOf(id) + 1,
        versionCount: siblingIds.length,
        continuation,
        // 从第 2 个元素开始查，第一个就是分支根自己
        deeper: collectBranchPoints(view, continuation, 1),
      }
    })

    points.push({ parent: parentId == null ? null : view.byId.get(parentId) ?? null, entries })
  }

  return points
}

/** 没有父节点的可见消息（会话开头的分支点） */
function rootIdsOf(view: ConversationView): string[] {
  const ids: string[] = []
  for (const message of view.byId.values()) {
    if (isRenderable(message) && attachableParent(message, view.byId) == null) ids.push(message.id)
  }
  return sortByTime(ids.map((id) => view.byId.get(id)!)).map((message) => message.id)
}

/** 附录统计，用来在标题上标一句「本对话有 N 处分叉」 */
export function summarizeBranches(view: ConversationView): { points: number; messages: number } {
  const points = collectBranchPoints(view, view.activePath)
  let messages = 0
  const walk = (list: BranchPoint[]): void => {
    for (const point of list) {
      for (const entry of point.entries) {
        messages += entry.continuation.length
        walk(entry.deeper)
      }
    }
  }
  walk(points)
  // points 只统计「沿主线」的分叉点，与正文提示数量一致；
  // 深层分支（分支内部又分叉）只计入 messages，不重复计数。
  return { points: points.length, messages }
}