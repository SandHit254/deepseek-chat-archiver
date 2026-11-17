import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { renderDocx } from '../src/core/render/docx'
import { normalizeConversation } from '../src/core/normalize'
import { buildConversationView } from '../src/core/tree'
import type { RawConversation } from '../src/core/types'

/**
 * docx 生成验证。
 *
 * 只断言"没抛错"是不够的——docx 是 zip 容器，必须验证：
 *   1. 产出的是合法 zip（含 [Content_Types].xml）
 *   2. 正文文字真的进了 document.xml
 *   3. 代码块、表格、思考过程这些结构化内容都被写进去
 *   4. 中文字符没有被转义破坏
 */

const raw: RawConversation = {
  chat_session: {
    id: 's1',
    title: '测试文档',
    model_type: 'deepseek_reasoner',
    inserted_at: 1700000000,
    updated_at: 1700003600,
    current_message_id: 'a2',
  },
  chat_messages: [
    {
      message_id: 'u1',
      parent_id: null,
      role: 'USER',
      inserted_at: 1700000010,
      files: [{ file_name: '图.png', signed_path: '/file?k=1', mime_type: 'image/png' }],
      fragments: [{ type: 'REQUEST', content: '给我一段代码和表格' }],
    },
    {
      message_id: 'a-old',
      parent_id: 'u1',
      role: 'ASSISTANT',
      inserted_at: 1700000050,
      fragments: [{ type: 'RESPONSE', content: '这是被弃用的回答' }],
    },
    {
      message_id: 'a2',
      parent_id: 'u1',
      role: 'ASSISTANT',
      model: 'deepseek-reasoner',
      inserted_at: 1700000100,
      fragments: [
        { type: 'THINK', content: '先想一下要不要给例子', elapsed_secs: 9 },
        { type: 'RESPONSE', content: '代码如下：\n\n```js\nconst x = 1\n```\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n- 要点一\n- 要点二' },
      ],
    },
  ],
}

async function build(): Promise<Uint8Array> {
  const conversation = normalizeConversation(raw, 's1')
  const view = buildConversationView(conversation)
  const blob = await renderDocx(view, {
    includeThinking: true,
    includeSources: true,
    includeBranches: true,
    includeAttachments: true,
    attachmentPaths: new Map([['u1', ['01_x/attachments/001_图.png']]]),
  })
  return new Uint8Array(await blob.arrayBuffer())
}

describe('docx 生成', () => {
  it('产出合法 docx（zip 容器 + 必需部件）', async () => {
    const bytes = await build()
    expect(bytes.byteLength).toBeGreaterThan(1000)
    // docx 是 zip，PK 魔数开头
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)

    const parts = unzipSync(bytes)
    expect(Object.keys(parts)).toContain('[Content_Types].xml')
    expect(Object.keys(parts)).toContain('word/document.xml')
  })

  it('正文、标题、思考过程都进了 document.xml', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)

    expect(document).toContain('测试文档')
    expect(document).toContain('给我一段代码和表格')
    expect(document).toContain('先想一下要不要给例子')
  })

  it('代码块内容与语言标记都在', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)
    expect(document).toContain('const x = 1')
    expect(document).toContain('js')
  })

  it('表格转成真正的 Word 表格', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)
    expect(document).toContain('<w:tbl>')
    expect(document).toContain('列A')
    expect(document).toContain('列B')
  })

  it('未选中分支进入附录，正文与之分离', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)
    expect(document).toContain('附录：未选中的分支')
    expect(document).toContain('这是被弃用的回答')
  })

  it('附件文件名被列出', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)
    expect(document).toContain('图.png')
  })

  it('中文没有被破坏成乱码或实体', async () => {
    const parts = unzipSync(await build())
    const document = strFromU8(parts['word/document.xml']!)
    expect(document).toContain('要点一')
    expect(document).toContain('要点二')
  })
})