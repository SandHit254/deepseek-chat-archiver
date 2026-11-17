/**
 * 轻量 Markdown 块级解析器。
 *
 * 为什么需要它：txt 与 docx 都要从 Markdown 正文生成结构，
 * 若各写一套必然出现「md 里有代码块、docx 里变成一坨纯文本」的偏差。
 * 统一在这里解析成 Block + InlineToken，三个格式共用同一份结构。
 *
 * 刻意只支持 DeepSeek 实际会输出的语法，不做完整 CommonMark：
 * 标题、段落、围栏代码块、引用、列表、表格、分隔线、行内格式。
 */

export interface InlineToken {
  text: string
  bold?: boolean
  italic?: boolean
  /** 行内代码，用等宽字体渲染 */
  code?: boolean
  /** 行内链接 */
  href?: string
  /** 已失效的删除线（~~text~~） */
  strike?: boolean
}

export type Block =
  | { kind: 'heading'; level: number; inline: InlineToken[] }
  | { kind: 'paragraph'; inline: InlineToken[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'quote'; inline: InlineToken[] }
  | { kind: 'list'; ordered: boolean; items: InlineToken[][] }
  | { kind: 'table'; header: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: 'divider' }

/* ------------------------------------------------------------------ *
 * 行内解析
 * ------------------------------------------------------------------ */

/**
 * 把一行文本切成带样式的 token。
 *
 * 先切出行内代码并占位——代码里的 `*` `[` 不该被当格式解析，
 * 这是最常见的错误来源。
 */
export function parseInline(source: string): InlineToken[] {
  if (source === '') return []

  const tokens: InlineToken[] = []
  const placeholders: string[] = []
  // 用不可见私用区字符做占位，避免与正文冲突
  const protect = (raw: string): string => {
    placeholders.push(raw)
    return `\uE000${placeholders.length - 1}\uE001`
  }

  // 1. 围栏式行内代码整体保护
  let working = source.replace(/(`+)([\s\S]*?)\1/g, (_match, _fence, code: string) => protect(code))

  // 2. 链接 -> 占位，记下文字与地址
  const links: Array<{ text: string; href: string }> = []
  working = working.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, text: string, href: string) => {
    links.push({ text: text || href, href })
    return `\uE100${links.length - 1}\uE101`
  })

  // 3. 按行内标记切分。逐段扫描比链式正则替换更可控，也不会互相吃掉标记。
  let cursor = 0

  const segments: Array<{ text: string; bold?: boolean; italic?: boolean; strike?: boolean }> = []
  const styleRegex = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|~~(?=\S)([\s\S]*?\S)~~/g
  let match: RegExpExecArray | null
  while ((match = styleRegex.exec(working)) !== null) {
    if (match.index > cursor) segments.push({ text: working.slice(cursor, match.index) })
    if (match[2] !== undefined) segments.push({ text: match[2], bold: true })
    else if (match[4] !== undefined) segments.push({ text: match[4], italic: true })
    else if (match[5] !== undefined) segments.push({ text: match[5], strike: true })
    cursor = match.index + match[0].length
  }
  if (cursor < working.length) segments.push({ text: working.slice(cursor) })

  // 4. 还原占位符
  const restore = (text: string): InlineToken[] => {
    const out: InlineToken[] = []
    const restoreRegex = /\uE000(\d+)\uE001|\uE100(\d+)\uE101/g
    let index = 0
    let hit: RegExpExecArray | null
    while ((hit = restoreRegex.exec(text)) !== null) {
      if (hit.index > index) out.push({ text: text.slice(index, hit.index) })
      if (hit[1] !== undefined) {
        out.push({ text: placeholders[Number(hit[1])] ?? '', code: true })
      } else if (hit[2] !== undefined) {
        const link = links[Number(hit[2])]
        if (link) out.push({ text: link.text, href: link.href })
      }
      index = hit.index + hit[0].length
    }
    if (index < text.length) out.push({ text: text.slice(index) })
    return out
  }

  for (const segment of segments) {
    const style: Partial<InlineToken> = {}
    if (segment.bold) style.bold = true
    if (segment.italic) style.italic = true
    if (segment.strike) style.strike = true
    for (const token of restore(segment.text)) {
      tokens.push({ ...token, ...style, ...(token.code ? { italic: false, bold: false } : {}) })
    }
  }

  return tokens.filter((token) => token.text !== '')
}

/** 把 token 还原成纯文本（用于 txt 与 docx 里不需要样式的场景） */
export function inlineToText(inline: InlineToken[]): string {
  return inline.map((token) => token.text).join('')
}

/* ------------------------------------------------------------------ *
 * 块级解析
 * ------------------------------------------------------------------ */

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/
const OL_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((cell) => cell.trim())
}

/**
 * 解析整段 Markdown 成块数组。
 *
 * DeepSeek 的正文本身就是 Markdown，所以这里其实是在解析「已知的良好输入」，
 * 不需要面对任意脏数据的极端情况——但代码块未闭合这种仍要容错。
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    // 空行
    if (line.trim() === '') {
      index += 1
      continue
    }

    // 围栏代码块：未闭合时吃到末尾，不能丢内容
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      const lang = fenceMatch[2] ?? ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length) {
        const current = lines[index]!
        if (current.trim().startsWith(marker[0]!.repeat(marker.length)) && current.trim().replace(/[`~]/g, '') === '') {
          index += 1
          break
        }
        codeLines.push(current)
        index += 1
      }
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    // 标题
    const headingMatch = HEADING.exec(line)
    if (headingMatch) {
      blocks.push({ kind: 'heading', level: headingMatch[1]!.length, inline: parseInline(headingMatch[2]!.trim()) })
      index += 1
      continue
    }

    // 分隔线（要在列表项之前判断，避免 --- 被当列表）
    if (DIVIDER.test(line)) {
      blocks.push({ kind: 'divider' })
      index += 1
      continue
    }

    // 表格
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      const header = splitTableRow(line).map(parseInline)
      index += 2
      const rows: InlineToken[][][] = []
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!).map(parseInline))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    // 引用：连续多行合并成一个 quote
    if (QUOTE.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoteLines.push(QUOTE.exec(lines[index]!)![1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', inline: parseInline(quoteLines.join(' ').trim()) })
      continue
    }

    // 列表：同类型的连续项归为一组
    const ulMatch = UL_ITEM.exec(line)
    const olMatch = OL_ITEM.exec(line)
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch)
      const items: InlineToken[][] = []
      while (index < lines.length) {
        const current = lines[index]!
        const currentUl = UL_ITEM.exec(current)
        const currentOl = OL_ITEM.exec(current)
        if (ordered) {
          if (!currentOl) break
          // 去掉缩进产生的层级差异，深层项用前置空格保住视觉缩进
          items.push(parseInline(`${'　'.repeat(Math.floor(currentOl[1]!.length / 2))}${currentOl[3]!}`))
          index += 1
        } else {
          if (!currentUl) break
          items.push(parseInline(`${'　'.repeat(Math.floor(currentUl[1]!.length / 2))}${currentUl[2]!}`))
          index += 1
        }
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 段落：吃到空行或下一个块起始为止
    const paragraphLines: string[] = []
    while (index < lines.length) {
      const current = lines[index]!
      if (current.trim() === '') break
      if (FENCE.test(current) || HEADING.test(current) || DIVIDER.test(current) || QUOTE.test(current)) break
      if (UL_ITEM.test(current) || OL_ITEM.test(current)) break
      if (TABLE_ROW.test(current) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) break
      paragraphLines.push(current)
      index += 1
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraphLines.join('\n').trim()) })
    } else {
      // 保险：万一上面某个分支没推进索引，强制前进避免死循环
      index += 1
    }
  }

  return blocks
}