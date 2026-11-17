import { describe, expect, it } from 'vitest'
import { normalizeConversation } from '../src/core/normalize'
import { buildConversationView, collectBranchPoints, summarizeBranches } from '../src/core/tree'
import type { RawConversation, RawMessage } from '../src/core/types'

/** 造一条最小可用的原始消息 */
function msg(
  id: string,
  parentId: string | null,
  role: 'USER' | 'ASSISTANT',
  content: string,
  extra: Partial<RawMessage> = {},
): RawMessage {
  return {
    message_id: id,
    parent_id: parentId,
    role,
    status: 'FINISHED',
    inserted_at: 1000,
    fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
    ...extra,
  }
}

function conversation(messages: RawMessage[], currentMessageId: string | null): RawConversation {
  return {
    chat_session: { id: 's1', title: 'T', current_message_id: currentMessageId },
    chat_messages: messages,
  }
}

describe('激活路径还原', () => {
  it('沿 current_message_id 回溯到根，输出正序', () => {
    const raw = conversation(
      [msg('u1', null, 'USER', 'Q1'), msg('a1', 'u1', 'ASSISTANT', 'A1'), msg('u2', 'a1', 'USER', 'Q2'), msg('a2', 'u2', 'ASSISTANT', 'A2')],
      'a2',
    )
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(view.branchPoints).toBe(0)
  })

  it('重新生成后，选中版本进主线，另一版本进分支', () => {
    const raw = conversation(
      [
        msg('u1', null, 'USER', 'Q1'),
        msg('a-old', 'u1', 'ASSISTANT', '旧版本', { inserted_at: 1100 }),
        msg('a-new', 'u1', 'ASSISTANT', '新版本', { inserted_at: 1200 }),
        msg('u2', 'a-new', 'USER', 'Q2', { inserted_at: 1300 }),
      ],
      'u2',
    )
    const normalized = normalizeConversation(raw, 's1')
    const view = buildConversationView(normalized)

    expect(view.activePath.map((m) => m.id)).toEqual(['u1', 'a-new', 'u2'])
    expect(view.branchPoints).toBe(1)
    expect(view.orphanCount).toBe(1)

    const points = collectBranchPoints(view, view.activePath)
    expect(points).toHaveLength(1)
    expect(points[0]!.parent?.id).toBe('u1')
    expect(points[0]!.entries.map((e) => e.message.id)).toEqual(['a-old'])
    expect(points[0]!.entries[0]!.version).toBe(1)
    expect(points[0]!.entries[0]!.versionCount).toBe(2)
  })

  it('current_message_id 缺失时退到最深最晚的叶子', () => {
    const raw = conversation(
      [
        msg('u1', null, 'USER', 'Q1'),
        msg('a1', 'u1', 'ASSISTANT', 'A1'),
        msg('a2', 'u1', 'ASSISTANT', 'A2', { inserted_at: 2000 }),
        msg('u2', 'a2', 'USER', 'Q2', { inserted_at: 3000 }),
      ],
      null,
    )
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.map((m) => m.id)).toEqual(['u1', 'a2', 'u2'])
  })

  it('current_message_id 指向不存在的消息时兜底，不抛错也不空', () => {
    const raw = conversation([msg('u1', null, 'USER', 'Q1'), msg('a1', 'u1', 'ASSISTANT', 'A1')], 'ghost')
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('parent 链自引用时不会死循环', () => {
    const raw = conversation(
      [
        { message_id: 'x', parent_id: 'x', role: 'USER', fragments: [{ type: 'REQUEST', content: 'loop' }] },
        msg('a1', 'x', 'ASSISTANT', 'A1'),
      ],
      'a1',
    )
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.length).toBeGreaterThan(0)
    expect(view.activePath.length).toBeLessThanOrEqual(2)
  })
})

describe('分支内部的更深分叉', () => {
  it('未选中分支自己又分叉时，取最新子节点为代表，其余记为更深分支', () => {
    const raw = conversation(
      [
        msg('u1', null, 'USER', 'Q1'),
        msg('a-main', 'u1', 'ASSISTANT', '主线版本', { inserted_at: 1500 }),
        // 未选中分支 a-old，其下又有两个助手版本
        msg('a-old', 'u1', 'ASSISTANT', '分支1', { inserted_at: 1100 }),
        msg('b-oldx', 'a-old', 'ASSISTANT', '分支1-旧', { inserted_at: 1200 }),
        msg('b-oldy', 'a-old', 'ASSISTANT', '分支1-新', { inserted_at: 1300 }),
      ],
      'a-main',
    )
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    const points = collectBranchPoints(view, view.activePath)
    const entry = points[0]!.entries[0]!

    expect(entry.message.id).toBe('a-old')
    // 默认往下取最新子节点
    expect(entry.continuation.map((m) => m.id)).toEqual(['a-old', 'b-oldy'])

    // b-oldx 是 a-old 下的另一个版本，属于更深分叉
    expect(entry.deeper).toHaveLength(1)
    expect(entry.deeper[0]!.parent?.id).toBe('a-old')
    expect(entry.deeper[0]!.entries.map((e) => e.message.id)).toEqual(['b-oldx'])
  })

  it('每个分支只输出独有内容，不重复共享前缀', () => {
    const raw = conversation(
      [
        msg('u1', null, 'USER', 'Q1'),
        msg('a1', 'u1', 'ASSISTANT', 'A1', { inserted_at: 1500 }),
        msg('u2', 'a1', 'USER', 'Q2', { inserted_at: 1600 }),
        msg('a2', 'u2', 'ASSISTANT', 'A2-旧', { inserted_at: 1700 }),
        msg('a2b', 'u2', 'ASSISTANT', 'A2-新', { inserted_at: 1800 }),
      ],
      'a2b',
    )
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    const summary = summarizeBranches(view)
    expect(summary.points).toBe(1)
    // 只有 a2 那一条进分支，u1/a1/u2 都是共享的
    expect(summary.messages).toBe(1)
  })
})

describe('隐藏消息与孤儿节点', () => {
  it('隐藏消息不进主线，也不会把子树截断', () => {
    const raw: RawConversation = {
      chat_session: { id: 's1', current_message_id: 'a2' },
      chat_messages: [
        msg('u1', null, 'USER', 'Q1'),
        msg('tip', 'u1', 'ASSISTANT', '内部提示', { is_visually_hidden_from_conversation: true } as never),
        msg('a1', 'tip', 'ASSISTANT', '真正的回答'),
        msg('a2', 'a1', 'ASSISTANT', '继续'),
      ],
    }
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
  })

  it('parent_id 指向不存在的消息时按根处理，不丢消息', () => {
    const raw = conversation([msg('u1', null, 'USER', 'Q1'), msg('a1', 'missing', 'ASSISTANT', 'A1')], null)
    const view = buildConversationView(normalizeConversation(raw, 's1'))
    expect(view.activePath.length).toBe(2)
  })

  it('重复 message_id 去重', () => {
    const raw = conversation(
      [msg('u1', null, 'USER', 'Q1'), msg('a1', 'u1', 'ASSISTANT', 'A1'), msg('a1', 'u1', 'ASSISTANT', 'A1-更新')],
      'a1',
    )
    const conversationResult = normalizeConversation(raw, 's1')
    expect(conversationResult.messages).toHaveLength(2)
    expect(conversationResult.messages[1]!.text).toBe('A1-更新')
  })
})