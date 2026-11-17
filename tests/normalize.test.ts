import { describe, expect, it } from 'vitest'
import { normalizeConversation, normalizeSession, resolveFileUrl, toEpochSeconds } from '../src/core/normalize'
import type { RawConversation } from '../src/core/types'

describe('时间归一化', () => {
  it('秒级数字原样保留', () => {
    expect(toEpochSeconds(1775290400)).toBe(1775290400)
  })

  it('毫秒级数字降到秒', () => {
    expect(toEpochSeconds(1775290400123)).toBe(1775290400)
  })

  it('数字字符串按数字处理', () => {
    expect(toEpochSeconds('1775290400')).toBe(1775290400)
  })

  it('无法识别时用兜底值', () => {
    expect(toEpochSeconds(undefined, 42)).toBe(42)
    expect(toEpochSeconds('not-a-date', 7)).toBe(7)
  })
})

describe('附件地址还原', () => {
  it('/file 路径改到文件服务域名并补 ty=p', () => {
    const url = resolveFileUrl({ signed_path: '/file?a=1' })
    expect(url).toBe('https://files.deepseeksvc.com/api/file?a=1&ty=p')
  })

  it('已有查询参数时不覆盖 ty', () => {
    const url = resolveFileUrl({ signed_path: '/file?a=1&ty=o' })
    expect(url).toContain('ty=o')
    expect(url).not.toContain('ty=p')
  })

  it('绝对 url 原样保留', () => {
    expect(resolveFileUrl({ url: 'https://example.com/x.png' })).toBe('https://example.com/x.png')
  })

  it('data URL 原样保留', () => {
    expect(resolveFileUrl({ signed_path: 'data:image/png;base64,AAA' })).toBe('data:image/png;base64,AAA')
  })

  it('没有可用路径时返回 null', () => {
    expect(resolveFileUrl({ file_name: 'x.png' })).toBeNull()
  })
})

describe('消息归一化', () => {
  const raw: RawConversation = {
    chat_session: { id: 's1', title: '  测试会话  ', current_message_id: 'a2', model_type: 'deepseek_reasoner' },
    chat_messages: [
      {
        message_id: 'u1',
        parent_id: null,
        role: 'USER',
        inserted_at: 1775290400,
        files: [{ file_name: 'diagram.png', signed_path: '/file?k=1', mime_type: 'image/png', file_size: 100 }],
        fragments: [{ type: 'REQUEST', content: '看图' }],
      },
      {
        message_id: 'a2',
        parent_id: 'u1',
        role: 'ASSISTANT',
        model: 'deepseek-reasoner',
        thinking_enabled: true,
        inserted_at: 1775290500,
        fragments: [
          { type: 'THINK', content: '先想一下', elapsed_secs: 5 },
          { type: 'THINK', content: '再想一下', elapsed_secs: 7 },
          { type: 'TOOL_SEARCH', results: [{ cite_index: 0, title: 'A', url: 'https://a.example', site_name: 'A站' }] },
          { type: 'RESPONSE', content: '答案[reference:0]' },
        ],
      },
    ],
  }

  it('标题去空白', () => {
    const view = normalizeConversation(raw, 's1')
    expect(view.session.title).toBe('测试会话')
    expect(view.session.modelType).toBe('deepseek_reasoner')
  })

  it('思考片段全部收集，耗时累加', () => {
    const view = normalizeConversation(raw, 's1')
    const assistant = view.messages[1]!
    expect(assistant.thinking).toEqual(['先想一下', '再想一下'])
    expect(assistant.thinkingSeconds).toBe(12)
  })

  it('正文只取 RESPONSE，不混入思考与工具', () => {
    const view = normalizeConversation(raw, 's1')
    expect(view.messages[1]!.text).toBe('答案[reference:0]')
  })

  it('搜索来源按 url 去重并保留序号', () => {
    const view = normalizeConversation(raw, 's1')
    const sources = view.messages[1]!.sources
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ index: 0, url: 'https://a.example', siteName: 'A站' })
  })

  it('附件从 message.files 提取，尺寸与可下载地址都在', () => {
    const view = normalizeConversation(raw, 's1')
    const attachment = view.messages[0]!.attachments[0]!
    expect(attachment.fileName).toBe('diagram.png')
    expect(attachment.isImage).toBe(true)
    expect(attachment.size).toBe(100)
    expect(attachment.url).toContain('files.deepseeksvc.com')
  })

  it('旧字段名 messages / reasoning_content 也能读', () => {
    const legacy: RawConversation = {
      chat_session: { id: 's2' },
      messages: [
        { message_id: 'm1', parent_id: null, role: 'ASSISTANT', reasoning_content: '旧版思考', content: '旧版正文' },
      ],
    }
    const view = normalizeConversation(legacy, 's2')
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]!.thinking).toEqual(['旧版思考'])
    expect(view.messages[0]!.text).toBe('旧版正文')
  })
})

describe('会话归一化', () => {
  it('无标题时给占位名', () => {
    const session = normalizeSession({ id: 7 })
    expect(session.title).toBe('未命名对话')
    expect(session.id).toBe('7')
  })

  it('pinned 为数字 0/1 时也能正确转布尔', () => {
    expect(normalizeSession({ id: 1, pinned: 1 }).pinned).toBe(true)
    expect(normalizeSession({ id: 1, pinned: 0 }).pinned).toBe(false)
  })

  it('current_message_id 指向不存在的消息时置空', () => {
    const view = normalizeConversation(
      { chat_session: { id: 's1', current_message_id: 'ghost' }, chat_messages: [] },
      's1',
    )
    expect(view.session.currentMessageId).toBeNull()
  })
})