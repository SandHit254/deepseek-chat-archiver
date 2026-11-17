import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { IParagraphOptions } from 'docx'
import type { ConversationView, Message } from '../types'
import type { BranchPoint } from '../tree'
import { collectBranchPoints, summarizeBranches } from '../tree'
import { parseMarkdown } from '../markdown'
import type { Block, InlineToken } from '../markdown'
import { formatDateTime } from './markdown'

/**
 * Word 文档生成。
 *
 * 关键约束：这个模块必须在 service worker 里跑（无 DOM、无 document）。
 * docx 库的 Packer.toBuffer 在浏览器环境返回 Promise<Blob>，
 * 所以不要去碰 Node 的 fs/Buffer。
 *
 * 样式选择理由：
 * - 代码块用等宽字体 + 灰底，不用表格包裹（表格在 Word 里跨页会裂开）
 * - 思考过程用带左边框的缩进段落，视觉上跟正文区分开
 * - 表格转成真正的 Word 表格，不是文本对齐
 */

export interface DocxOptions {
  includeThinking: boolean
  includeSources: boolean
  includeBranches: boolean
  includeAttachments: boolean
  attachmentPaths?: Map<string, string[]>
}

const MONO_FONT = 'Consolas'
const CODE_SHADING = 'F4F4F5'
const THINK_SHADING = 'FAFAFA'

function roleLabel(role: Message['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'system') return '系统'
  return '工具'
}

/* ------------------------------------------------------------------ *
 * 行内 token → docx TextRun
 * ------------------------------------------------------------------ */

function runsFromInline(inline: InlineToken[]): TextRun[] {
  return inline.map((token) => new TextRun({
    text: token.text,
    bold: token.bold,
    italics: token.italic,
    strike: token.strike,
    font: token.code ? MONO_FONT : undefined,
    shading: token.code ? { type: ShadingType.CLEAR, fill: CODE_SHADING, color: 'auto' } : undefined,
  }))
}

/* ------------------------------------------------------------------ *
 * Markdown 块 → docx 段落
 * ------------------------------------------------------------------ */

function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const map = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ]
  return map[Math.min(level, 6) - 1] ?? HeadingLevel.HEADING_6
}

/**
 * 中英文之间插一个空格，Word 里不插会显得挤在一起。
 * 只在纯文本节点上做，代码块里绝不能加。
 */
function spaceCjk(text: string): string {
  return text.replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([\u3400-\u9fff])/g, '$1 $2')
}

function blocksToParagraphs(blocks: Block[], listCounter: { value: number }): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = []

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        output.push(new Paragraph({
          heading: headingLevel(block.level),
          children: runsFromInline(block.inline),
          spacing: { before: 240, after: 120 },
        }))
        break
      }
      case 'paragraph': {
        output.push(new Paragraph({
          children: runsFromInline(block.inline.map((token) => ({ ...token, text: spaceCjk(token.text) }))),
          spacing: { after: 120, line: 320 },
        }))
        break
      }
      case 'code': {
        // 逐行成段，保留空行；用一个整体灰底段落包住不够，Word 里会丢换行
        const codeLines = block.code.split('\n')
        if (block.lang) {
          output.push(new Paragraph({
            children: [new TextRun({ text: block.lang, font: MONO_FONT, size: 16, color: '71717A' })],
            spacing: { before: 120, after: 0 },
          }))
        }
        codeLines.forEach((line, index) => {
          output.push(new Paragraph({
            children: [new TextRun({ text: line === '' ? ' ' : line, font: MONO_FONT, size: 18 })],
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING, color: 'auto' },
            spacing: {
              before: index === 0 ? 120 : 0,
              after: index === codeLines.length - 1 ? 160 : 0,
              line: 260,
            },
            indent: { left: 240 },
          }))
        })
        break
      }
      case 'quote': {
        output.push(new Paragraph({
          children: runsFromInline(block.inline.map((token) => ({ ...token, text: spaceCjk(token.text) }))),
          indent: { left: 360 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: 'D4D4D8', space: 12 },
          },
          spacing: { after: 120 },
        }))
        break
      }
      case 'list': {
        for (const item of block.items) {
          output.push(new Paragraph({
            children: runsFromInline(item.map((token) => ({ ...token, text: spaceCjk(token.text) }))),
            ...(block.ordered
              ? { numbering: { reference: 'ordered-list', level: 0 } }
              : { bullet: { level: 0 } }),
            spacing: { after: 60 },
          } as IParagraphOptions))
        }
        break
      }
      case 'table': {
        const headerCells = block.header.map((cell) => new TableCell({
          children: [new Paragraph({
            children: runsFromInline(cell).map((run) => run),
            spacing: { after: 40 },
          })],
          shading: { type: ShadingType.CLEAR, fill: 'F4F4F5', color: 'auto' },
        }))
        const rows = block.rows.map((row) => new TableRow({
          children: row.map((cell) => new TableCell({
            children: [new Paragraph({ children: runsFromInline(cell), spacing: { after: 40 } })],
          })),
        }))
        output.push(new Table({
          rows: [new TableRow({ children: headerCells, tableHeader: true }), ...rows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }))
        // 表格后补一个空段，否则两张表会贴在一起
        output.push(new Paragraph({ children: [], spacing: { after: 120 } }))
        break
      }
      case 'divider': {
        output.push(new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E4E4E7', space: 1 } },
          spacing: { before: 120, after: 120 },
        }))
        break
      }
    }
  }

  listCounter.value += 1
  return output
}

/* ------------------------------------------------------------------ *
 * 消息 → docx
 * ------------------------------------------------------------------ */

function thinkingParagraphs(message: Message): Paragraph[] {
  if (message.thinking.length === 0) return []

  const seconds = message.thinkingSeconds
  const label = seconds && seconds > 0 ? `深度思考（${seconds} 秒）` : '深度思考'
  const output: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: label, bold: true, size: 20, color: '71717A' })],
      spacing: { before: 120, after: 80 },
      shading: { type: ShadingType.CLEAR, fill: THINK_SHADING, color: 'auto' },
    }),
  ]

  for (const block of parseMarkdown(message.thinking.join('\n\n'))) {
    if (block.kind === 'heading') {
      output.push(new Paragraph({
        children: [new TextRun({ text: block.inline.map((t) => t.text).join(''), bold: true, size: 21, color: '52525B' })],
        indent: { left: 240 },
        shading: { type: ShadingType.CLEAR, fill: THINK_SHADING, color: 'auto' },
        spacing: { after: 60 },
      }))
      continue
    }
    if (block.kind === 'paragraph') {
      output.push(new Paragraph({
        children: block.inline.map((token) => new TextRun({
          text: spaceCjk(token.text),
          bold: token.bold,
          italics: true,
          font: token.code ? MONO_FONT : undefined,
          color: '52525B',
          size: 20,
        })),
        indent: { left: 240 },
        shading: { type: ShadingType.CLEAR, fill: THINK_SHADING, color: 'auto' },
        spacing: { after: 80, line: 280 },
      }))
    }
  }
  return output
}

function messageParagraphs(message: Message, options: DocxOptions): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = []

  const meta = [roleLabel(message.role), formatDateTime(message.insertedAt)]
  if (message.model) meta.push(message.model)

  output.push(new Paragraph({
    children: [new TextRun({ text: meta.join('  ·  '), bold: true, size: 20, color: '3F3F46' })],
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E4E4E7', space: 4 } },
  }))

  if (options.includeThinking) {
    output.push(...thinkingParagraphs(message))
  }

  output.push(...blocksToParagraphs(parseMarkdown(message.text), { value: 0 }))

  if (options.includeSources && message.sources.length > 0) {
    output.push(new Paragraph({
      children: [new TextRun({ text: '参考来源', bold: true, size: 20, color: '71717A' })],
      spacing: { before: 120, after: 60 },
    }))
    for (const source of message.sources) {
      const text = `[${source.index + 1}] ${source.title}${source.siteName ? `（${source.siteName}）` : ''} — ${source.url}`
      output.push(new Paragraph({
        children: [new TextRun({ text, size: 18, color: '52525B' })],
        indent: { left: 240 },
        spacing: { after: 40 },
      }))
    }
  }

  if (options.includeAttachments && message.attachments.length > 0) {
    const paths = options.attachmentPaths?.get(message.id) ?? []
    output.push(new Paragraph({
      children: [new TextRun({ text: '附件', bold: true, size: 20, color: '71717A' })],
      spacing: { before: 120, after: 60 },
    }))
    for (const attachment of message.attachments) {
      const relative = paths.find((path) => path.includes(attachment.fileName))
      output.push(new Paragraph({
        children: [new TextRun({
          text: `${attachment.fileName}${relative ? ` → ${relative}` : '（未下载）'}`,
          size: 18,
          color: '52525B',
        })],
        indent: { left: 240 },
        spacing: { after: 40 },
      }))
    }
  }

  return output
}

function branchParagraphs(points: BranchPoint[], options: DocxOptions): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = []
  if (points.length === 0) return output

  output.push(new Paragraph({
    children: [new TextRun({ text: '附录：未选中的分支', bold: true, size: 32 })],
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160 },
    pageBreakBefore: true,
  }))
  output.push(new Paragraph({
    children: [new TextRun({
      text: '以下为「重新生成」或「编辑后重发」产生的历史版本，未被选中，未出现在正文中。',
      italics: true,
      size: 20,
      color: '71717A',
    })],
    spacing: { after: 200 },
  }))

  const walk = (list: BranchPoint[], depth: number): void => {
    list.forEach((point, index) => {
      const where = point.parent
        ? `接在 ${roleLabel(point.parent.role)} · ${formatDateTime(point.parent.insertedAt)} 之后`
        : '会话开头'
      output.push(new Paragraph({
        children: [new TextRun({ text: `分支点 ${index + 1}：${where}`, bold: true, size: 24 })],
        heading: depth === 0 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 120 },
      }))

      for (const entry of point.entries) {
        output.push(new Paragraph({
          children: [new TextRun({
            text: `版本 ${entry.version} / ${entry.versionCount}`,
            bold: true,
            size: 22,
            color: '3F3F46',
          })],
          spacing: { before: 160, after: 80 },
        }))
        for (const message of entry.continuation) {
          output.push(...messageParagraphs(message, options))
        }
        walk(entry.deeper, depth + 1)
      }
    })
  }
  walk(points, 0)

  return output
}

/* ------------------------------------------------------------------ *
 * 文档组装
 * ------------------------------------------------------------------ */

export async function renderDocx(view: ConversationView, options: DocxOptions): Promise<Blob> {
  const session = view.session
  const points = options.includeBranches ? collectBranchPoints(view, view.activePath) : []
  const summary = summarizeBranches(view)

  const children: Array<Paragraph | Table> = []

  children.push(new Paragraph({
    children: [new TextRun({ text: session.title, bold: true, size: 40 })],
    heading: HeadingLevel.TITLE,
    spacing: { after: 160 },
  }))

  const metaLines = [
    `会话 ID：${session.id}`,
    ...(session.modelType ? [`模型：${session.modelType}`] : []),
    `创建时间：${formatDateTime(session.createdAt)}`,
    `更新时间：${formatDateTime(session.updatedAt)}`,
    `消息数：${view.activePath.length}`,
    ...(options.includeBranches && summary.points > 0
      ? [`分叉：${summary.points} 处，未选中分支 ${summary.messages} 条`]
      : []),
  ]
  for (const line of metaLines) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line, size: 18, color: '71717A' })],
      spacing: { after: 40 },
    }))
  }

  for (const message of view.activePath) {
    children.push(...messageParagraphs(message, options))
  }

  children.push(...branchParagraphs(points, options))

  const document = new Document({
    creator: 'DeepSeek Chat Archiver',
    title: session.title,
    description: `DeepSeek 对话归档 · ${session.id}`,
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 480, hanging: 240 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Microsoft YaHei', size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
        },
        children,
      },
    ],
  })

  return Packer.toBlob(document)
}