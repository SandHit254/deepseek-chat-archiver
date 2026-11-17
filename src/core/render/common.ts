import type { ConversationView, Message } from '../types'

/**
 * 格式化相关的公共工具。
 *
 * 这些函数原本在 markdown.ts / text.ts / docx.ts 里各写一份，结果改了一处
 * 漏掉另两处（浮点秒数 9.872726393 只在一个格式里被修正）。集中到这里，
 * 保证三种输出的一致性。
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 秒级 epoch → 本地时间字符串。
 *
 * 带明确的时区标注（UTC+08:00），因为导出文件可能被传到别的时区打开，
 * 不标时区会产生歧义。
 */
export function formatDateTime(epochSeconds: number): string {
  if (!epochSeconds) return '未知时间'
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) return '未知时间'

  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} `
    + `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/**
 * 思考耗时。
 *
 * 接口返回的是浮点秒（实测见过 9.872726393），必须取整，
 * 否则界面上会出现一长串无意义的小数。
 */
export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.round(seconds)
  if (total <= 0) return ''
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/** 角色中文名，三种格式共用 */
export function roleLabel(role: Message['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'system') return '系统'
  return '工具'
}

/** YAML frontmatter 的值转义：标题里带冒号/引号很常见 */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 引用角标转可点击链接。
 *
 * DeepSeek 正文里用 [reference:0] 这种相对序号，必须结合 sources 才能还原
 * 成真实 URL，否则导出后只是一堆无意义标记。
 */
export function linkCitations(text: string, message: Message): string {
  if (message.sources.length === 0) return text
  return text.replace(/\[reference:(\d+)\]/g, (match, rawIndex: string) => {
    const wanted = Number(rawIndex)
    const source = message.sources.find((item) => item.index === wanted) ?? message.sources[wanted]
    if (!source) return match
    return `[${wanted + 1}](${source.url})`
  })
}

/** 中英文之间插一个空格，Word 里不插会显得挤在一起 */
export function spaceCjk(text: string): string {
  return text
    .replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u3400-\u9fff])/g, '$1 $2')
}

/** 会话概览行，三种格式共用同一套措辞 */
export function sessionSummaryLines(view: ConversationView, branchPoints: number, branchMessages: number): string[] {
  const session = view.session
  const lines = [
    `会话 ID：${session.id}`,
    ...(session.modelType ? [`模型：${session.modelType}`] : []),
    `创建时间：${formatDateTime(session.createdAt)}`,
    `更新时间：${formatDateTime(session.updatedAt)}`,
    `消息数：${view.activePath.length}`,
  ]
  if (branchPoints > 0) {
    lines.push(`分叉：${branchPoints} 处，未选中分支 ${branchMessages} 条（见文末附录）`)
  }
  return lines
}