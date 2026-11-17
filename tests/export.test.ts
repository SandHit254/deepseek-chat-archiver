import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { runExport } from '../src/content/exporter'
import type { ApiEnvelope } from '../src/core/types'

/**
 * 端到端测试：用假的接口响应跑完整导出链路。
 *
 * 这是最接近真实使用的一层验证——它同时覆盖
 * 接口分页 → 归一化 → 建树 → 渲染 → 附件 → zip 打包。
 *
 * 附件下载依赖 chrome.runtime，测试里用全局桩替代。
 */

const SESSIONS = [
  { id: 's1', title: '如何实现分布式锁', model_type: 'deepseek_reasoner', inserted_at: 1700000000, updated_at: 1700003600, pinned: true, current_message_id: 's1-a2' },
  { id: 's2', title: '新对话', inserted_at: 1700001000, updated_at: 1700002000, current_message_id: 's2-a1' },
]

const HISTORIES: Record<string, unknown> = {
  s1: {
    chat_session: SESSIONS[0],
    chat_messages: [
      {
        message_id: 's1-u1',
        parent_id: null,
        role: 'USER',
        inserted_at: 1700000010,
        files: [{ file_name: '架构图.png', signed_path: '/file?token=abc', mime_type: 'image/png', file_size: 2048 }],
        fragments: [{ type: 'REQUEST', content: '怎么实现分布式锁？' }],
      },
      {
        message_id: 's1-a1',
        parent_id: 's1-u1',
        role: 'ASSISTANT',
        model: 'deepseek-reasoner',
        inserted_at: 1700000100,
        fragments: [
          { type: 'THINK', content: '先考虑 Redis 方案', elapsed_secs: 12 },
          { type: 'RESPONSE', content: '可以用 Redis[reference:0]' },
        ],
      },
      {
        message_id: 's1-a2',
        parent_id: 's1-u1',
        role: 'ASSISTANT',
        model: 'deepseek-reasoner',
        inserted_at: 1700000200,
        fragments: [
          { type: 'THINK', content: '这次换个思路说', elapsed_secs: 6 },
          { type: 'TOOL_SEARCH', results: [{ cite_index: 0, title: 'Redis 官方文档', url: 'https://redis.io/docs', site_name: 'Redis' }] },
          { type: 'RESPONSE', content: 'Redis 的 SET NX 方案[reference:0]\n\n```js\nawait redis.set(key, id, "NX")\n```' },
        ],
      },
      {
        message_id: 's1-u2',
        parent_id: 's1-a2',
        role: 'USER',
        inserted_at: 1700000300,
        fragments: [{ type: 'REQUEST', content: '那 ZooKeeper 呢？' }],
      },
    ],
  },
  s2: {
    chat_session: SESSIONS[1],
    chat_messages: [
      {
        message_id: 's2-u1',
        parent_id: null,
        role: 'USER',
        inserted_at: 1700001100,
        fragments: [{ type: 'REQUEST', content: '你好' }],
      },
      {
        message_id: 's2-a1',
        parent_id: 's2-u1',
        role: 'ASSISTANT',
        inserted_at: 1700001200,
        fragments: [{ type: 'RESPONSE', content: '你好，有什么可以帮你？' }],
      },
    ],
  },
}

/** 构造一个假的请求器，模拟 DeepSeek 接口信封结构 */
function fakeRequester() {
  return async (path: string): Promise<ApiEnvelope<unknown>> => {
    if (path.startsWith('/api/v0/chat_session/fetch_page')) {
      return { code: 0, data: { biz_code: 0, biz_data: { chat_sessions: SESSIONS, has_more: false } } }
    }
    const match = /chat_session_id=([^&]+)/.exec(path)
    if (match) {
      const id = decodeURIComponent(match[1]!)
      const data = HISTORIES[id]
      if (!data) return { code: 0, data: { biz_code: 0, biz_data: undefined } }
      return { code: 0, data: { biz_code: 0, biz_data: data } }
    }
    return { code: 0, data: { biz_code: 0, biz_data: undefined } }
  }
}

/** 桩掉 chrome.runtime（附件下载与归档保存都走它） */
function installChromeStub(): void {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const base64 = Buffer.from(pngBytes).toString('base64')

  ;(globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: async (message: { type?: string; payload?: { url?: string } }) => {
        if (message.type === 'attachment:download') {
          // 模拟文件服务返回图片
          return { ok: true, dataUrl: `data:image/png;base64,${base64}`, mimeType: 'image/png', byteLength: 8 }
        }
        return { ok: true }
      },
    },
  }
}

describe('端到端导出', () => {
  it('产出完整 zip，包含各格式文档与附件', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      {
        formats: ['md', 'txt', 'json'],
        includeThinking: true,
        includeSources: true,
        includeBranches: true,
        includeAttachments: true,
      },
    )

    expect(result.summary.sessions).toBe(2)
    expect(result.summary.succeeded).toBe(2)
    expect(result.summary.failed).toBe(0)
    expect(result.errors).toHaveLength(0)

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const paths = Object.keys(unzipped)

    // 批次清单
    expect(paths.some((path) => path.endsWith('/manifest.json'))).toBe(true)

    // 第一个会话（有分叉、有附件、有思考）
    const s1 = paths.filter((path) => path.includes('分布式锁'))
    expect(s1.some((path) => path.endsWith('conversation.md'))).toBe(true)
    expect(s1.some((path) => path.endsWith('conversation.txt'))).toBe(true)
    expect(s1.some((path) => path.endsWith('conversation.json'))).toBe(true)

    // 第二个会话同名风险：标题是「新对话」，靠 id 后缀区分
    const s2 = paths.filter((path) => path.includes('新对话'))
    expect(s2.length).toBeGreaterThan(0)
  })

  it('Markdown 内容正确：主线 + 附录 + 思考 + 引用 + 附件', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      { formats: ['md'], includeThinking: true, includeSources: true, includeBranches: true, includeAttachments: true },
    )

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const mdPath = Object.keys(unzipped).find((path) => path.includes('分布式锁') && path.endsWith('.md'))!
    const markdown = strFromU8(unzipped[mdPath]!)

    // 主线只走选中的 a2，被弃用的 a1 不应出现在正文
    const appendixIndex = markdown.indexOf('附录：未选中的分支')
    expect(appendixIndex).toBeGreaterThan(0)
    const body = markdown.slice(0, appendixIndex)
    expect(body).toContain('Redis 的 SET NX 方案')
    expect(body).not.toContain('可以用 Redis')

    // 附录里有被弃用的版本
    expect(markdown.slice(appendixIndex)).toContain('可以用 Redis')

    // 思考过程带耗时
    expect(markdown).toContain('这次换个思路说')
    expect(markdown).toContain('深度思考（6 秒）')

    // 引用还原成链接
    expect(markdown).toContain('[1](https://redis.io/docs)')

    // 附件指向相对路径
    expect(markdown).toContain('架构图.png')
    expect(markdown).toContain('attachments/001_')
  })

  it('附件被真实写入 zip，并生成附件清单', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      { formats: ['md'], includeThinking: true, includeSources: true, includeBranches: true, includeAttachments: true },
    )

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const attachmentPaths = Object.keys(unzipped).filter((path) => path.includes('attachments/'))
    expect(attachmentPaths.some((path) => path.endsWith('.png'))).toBe(true)
    expect(attachmentPaths.some((path) => path.endsWith('_manifest.json'))).toBe(true)
    expect(result.summary.attachments).toBe(1)
  })

  it('JSON 保留分支树与激活路径', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      { formats: ['json'], includeThinking: true, includeSources: true, includeBranches: true, includeAttachments: false },
    )

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const jsonPath = Object.keys(unzipped).find((path) => path.includes('分布式锁') && path.endsWith('.json'))!
    const parsed = JSON.parse(strFromU8(unzipped[jsonPath]!))

    expect(parsed.format).toBe('deepseek-chat-archiver/v1')
    // 4 条消息全在（含未选中的 a1）
    expect(parsed.messages).toHaveLength(4)
    expect(parsed.session.activeBranch.messageIds).toEqual(['s1-u1', 's1-a2', 's1-u2'])
    expect(parsed.session.branches.points).toBe(1)
  })

  it('可只导出指定会话', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      {
        formats: ['md'],
        includeThinking: true,
        includeSources: true,
        includeBranches: true,
        includeAttachments: false,
        sessionIds: ['s2'],
      },
    )

    expect(result.summary.sessions).toBe(1)
    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const summaries = Object.keys(unzipped).filter((path) => path.endsWith('.md'))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('新对话')
  })

  it('单个会话抓取失败时整批继续', async () => {
    installChromeStub()
    const base = fakeRequester()
    const flaky = async (path: string): Promise<ApiEnvelope<unknown>> => {
      if (path.includes('chat_session_id=s1')) {
        throw new Error('模拟接口错误')
      }
      return base(path)
    }

    const result = await runExport(
      { request: flaky },
      { formats: ['md'], includeThinking: true, includeSources: true, includeBranches: true, includeAttachments: false },
    )

    expect(result.summary.sessions).toBe(2)
    expect(result.summary.succeeded).toBe(1)
    expect(result.summary.failed).toBe(1)
    expect(result.errors.some((error) => error.error.includes('模拟接口错误'))).toBe(true)
  })

  it('manifest 汇总统计正确', async () => {
    installChromeStub()

    const result = await runExport(
      { request: fakeRequester() },
      { formats: ['md'], includeThinking: true, includeSources: true, includeBranches: true, includeAttachments: true },
    )

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const manifestPath = Object.keys(unzipped).find((path) => path.endsWith('/manifest.json'))!
    const manifest = JSON.parse(strFromU8(unzipped[manifestPath]!))

    expect(manifest.summary.total).toBe(2)
    expect(manifest.summary.succeeded).toBe(2)
    expect(manifest.summary.branchPoints).toBe(1)
    expect(manifest.sessions).toHaveLength(2)
  })
})