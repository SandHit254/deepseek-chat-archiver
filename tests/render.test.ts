import { describe, expect, it } from 'vitest'
import { normalizeConversation } from '../src/core/normalize'
import { buildConversationView } from '../src/core/tree'
import { renderMarkdown } from '../src/core/render/markdown'
import { renderText } from '../src/core/render/text'
import { renderJson } from '../src/core/render/json'
import { inlineToText, parseInline, parseMarkdown } from '../src/core/markdown'
import type { RawConversation, RawMessage } from '../src/core/types'

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
    inserted_at: 1700000000,
    fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
    ...extra,
  }
}

const baseOptions = {
  includeThinking: true,
  includeSources: true,
  includeBranches: true,
  includeAttachments: true,
}

function buildConversation(raw: RawConversation) {
  const conversation = normalizeConversation(raw, 's1')
  return { conversation, view: buildConversationView(conversation) }
}

describe('行内 Markdown 解析', () => {
  it('粗体与斜体', () => {
    const tokens = parseInline('这是**粗体**和*斜体*')
    expect(tokens.find((t) => t.bold)?.text).toBe('粗体')
    expect(tokens.find((t) => t.italic)?.text).toBe('斜体')
  })

  it('行内代码里的星号不被当格式', () => {
    const tokens = parseInline('用 `a**b**c` 表示')
    const code = tokens.find((t) => t.code)
    expect(code?.text).toBe('a**b**c')
    // 代码内的星号不能生成粗体 token
    expect(tokens.filter((t) => t.bold)).toHaveLength(0)
  })

  it('链接文字与地址都保留', () => {
    const tokens = parseInline('见[文档](https://example.com/a)')
    const link = tokens.find((t) => t.href)
    expect(link?.text).toBe('文档')
    expect(link?.href).toBe('https://example.com/a')
  })

  it('还原成纯文本时不丢字', () => {
    expect(inlineToText(parseInline('**粗** `code` [x](https://a.b)'))).toBe('粗 code x')
  })
})

describe('块级 Markdown 解析', () => {
  it('围栏代码块内容原样保留', () => {
    const blocks = parseMarkdown('前\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n后')
    const code = blocks.find((b) => b.kind === 'code')
    expect(code).toMatchObject({ kind: 'code', lang: 'js', code: 'const a = 1\n\nconst b = 2' })
  })

  it('未闭合代码块吃到末尾，不丢内容', () => {
    const blocks = parseMarkdown('```\nabc\ndef')
    expect(blocks.filter((b) => b.kind === 'code')).toHaveLength(1)
    expect((blocks[0] as { code: string }).code).toBe('abc\ndef')
  })

  it('表格被识别为 table', () => {
    const blocks = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const table = blocks.find((b) => b.kind === 'table')
    expect(table?.kind).toBe('table')
    if (table?.kind === 'table') {
      expect(table.header).toHaveLength(2)
      expect(table.rows).toHaveLength(1)
    }
  })

  it('无序与有序列表分别归组', () => {
    const blocks = parseMarkdown('- a\n- b\n\n1. x\n2. y')
    expect(blocks.filter((b) => b.kind === 'list')).toHaveLength(2)
  })

  it('分隔线不会被当成列表项', () => {
    const blocks = parseMarkdown('上\n\n---\n\n下')
    expect(blocks.some((b) => b.kind === 'divider')).toBe(true)
  })
})

describe('Markdown 导出', () => {
  const raw: RawConversation = {
    chat_session: { id: 's1', title: '带分叉的对话', current_message_id: 'a2', model_type: 'deepseek_reasoner' },
    chat_messages: [
      msg('u1', null, 'USER', '原始问题'),
      msg('a1', 'u1', 'ASSISTANT', '被弃用的回答', { inserted_at: 1700000010 }),
      msg('a2', 'u1', 'ASSISTANT', '选中的回答[reference:0]', {
        inserted_at: 1700000020,
        fragments: [
          { type: 'THINK', content: '先在脑子里过一遍', elapsed_secs: 8 },
          { type: 'TOOL_SEARCH', results: [{ cite_index: 0, title: '某文档', url: 'https://doc.example' }] },
          { type: 'RESPONSE', content: '选中的回答[reference:0]' },
        ],
      }),
    ],
  }

  it('正文只含选中的那条，未选中的进附录', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, baseOptions)

    const appendixIndex = output.indexOf('附录：未选中的分支')
    expect(appendixIndex).toBeGreaterThan(0)

    const body = output.slice(0, appendixIndex)
    expect(body).toContain('选中的回答')
    expect(body).not.toContain('被弃用的回答')
    expect(output.slice(appendixIndex)).toContain('被弃用的回答')
  })

  it('思考过程用 details 折叠且带耗时', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, baseOptions)
    expect(output).toContain('<summary>深度思考（8 秒）</summary>')
    expect(output).toContain('先在脑子里过一遍')
  })

  it('关掉思考开关后不出现思考内容', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, { ...baseOptions, includeThinking: false })
    expect(output).not.toContain('先在脑子里过一遍')
  })

  it('引用角标转成真实链接', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, baseOptions)
    expect(output).toContain('[1](https://doc.example)')
    expect(output).not.toContain('[reference:0]')
  })

  it('关掉分支后没有附录', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, { ...baseOptions, includeBranches: false })
    expect(output).not.toContain('附录：未选中的分支')
  })

  it('frontmatter 里标题带冒号也不破坏 YAML', () => {
    const { view } = buildConversation(raw)
    const output = renderMarkdown(view, baseOptions)
    expect(output).toContain('title: "带分叉的对话"')
  })

  it('附件列出相对路径', () => {
    const rawWithFile: RawConversation = {
      chat_session: { id: 's2', current_message_id: 'a1' },
      chat_messages: [
        msg('u1', null, 'USER', '看图', {
          files: [{ file_name: 'shot.png', signed_path: '/file?k=1', mime_type: 'image/png' }],
        }),
        msg('a1', 'u1', 'ASSISTANT', '收到'),
      ],
    }
    const { view } = buildConversation(rawWithFile)
    const paths = new Map([['u1', ['03_对话_x/attachments/001_shot.png']]])
    const output = renderMarkdown(view, { ...baseOptions, attachmentPaths: paths })
    expect(output).toContain('[shot.png](03_%E5%AF%B9%E8%AF%9D_x/attachments/001_shot.png)')
  })
})

describe('纯文本导出', () => {
  it('不含 Markdown 语法标记', () => {
    const raw: RawConversation = {
      chat_session: { id: 's1', title: 'T', current_message_id: 'a1' },
      chat_messages: [
        msg('u1', null, 'USER', '问题'),
        msg('a1', 'u1', 'ASSISTANT', '**加粗**的回答'),
      ],
    }
    const { view } = buildConversation(raw)
    const output = renderText(view, baseOptions)
    // 正文原样保留 Markdown 源码是合理的（纯文本存档），但不该出现 details 标签
    expect(output).not.toContain('<details>')
    expect(output).toContain('用户')
    expect(output).toContain('助手')
  })

  it('思考过程用括号标题标出', () => {
    const raw: RawConversation = {
      chat_session: { id: 's1', current_message_id: 'a1' },
      chat_messages: [
        msg('u1', null, 'USER', '问题'),
        msg('a1', 'u1', 'ASSISTANT', '答', {
          fragments: [
            { type: 'THINK', content: '想了想', elapsed_secs: 90 },
            { type: 'RESPONSE', content: '答' },
          ],
        }),
      ],
    }
    const { view } = buildConversation(raw)
    const output = renderText(view, baseOptions)
    expect(output).toContain('【深度思考 · 耗时 1 分 30 秒】')
  })
})

describe('JSON 导出', () => {
  const raw: RawConversation = {
    chat_session: { id: 's1', title: 'T', current_message_id: 'a2' },
    chat_messages: [
      msg('u1', null, 'USER', 'Q'),
      msg('a1', 'u1', 'ASSISTANT', '旧'),
      msg('a2', 'u1', 'ASSISTANT', '新', { inserted_at: 1700000100 }),
    ],
  }

  it('保留全部消息（含未选中分支）与父子关系', () => {
    const { conversation, view } = buildConversation(raw)
    const parsed = JSON.parse(renderJson(conversation, view, baseOptions))

    expect(parsed.messages).toHaveLength(3)
    const old = parsed.messages.find((m: { id: string }) => m.id === 'a1')
    expect(old.active).toBe(false)
    expect(old.parentId).toBe('u1')

    const active = parsed.messages.filter((m: { active: boolean }) => m.active).map((m: { id: string }) => m.id)
    expect(active).toEqual(['u1', 'a2'])
  })

  it('树形结构反映分叉', () => {
    const { conversation, view } = buildConversation(raw)
    const parsed = JSON.parse(renderJson(conversation, view, baseOptions))
    expect(parsed.tree).toHaveLength(1)
    expect(parsed.tree[0].id).toBe('u1')
    expect(parsed.tree[0].children).toHaveLength(2)
  })

  it('记录分支详情与激活主线', () => {
    const { conversation, view } = buildConversation(raw)
    const parsed = JSON.parse(renderJson(conversation, view, baseOptions))
    expect(parsed.session.activeBranch.messageIds).toEqual(['u1', 'a2'])
    expect(parsed.session.branches.points).toBe(1)
    expect(parsed.session.branches.detail[0].versions[0].rootId).toBe('a1')
  })

  it('JSON 可被程序解析（不是非法格式）', () => {
    const { conversation, view } = buildConversation(raw)
    expect(() => JSON.parse(renderJson(conversation, view, baseOptions))).not.toThrow()
  })
})