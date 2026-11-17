import { describe, expect, it } from 'vitest'
import { formatDateTime, formatDuration, linkCitations, spaceCjk } from '../src/core/render/common'
import type { Message } from '../src/core/types'

describe('耗时格式化', () => {
  it('浮点秒数取整，不出现一长串小数', () => {
    // 真实接口返回过 9.872726393 这样的值
    expect(formatDuration(9.872726393)).toBe('10 秒')
    expect(formatDuration(0.4)).toBe('')
    expect(formatDuration(1.5)).toBe('2 秒')
  })

  it('超过一分钟换算成「分」', () => {
    expect(formatDuration(60)).toBe('1 分')
    expect(formatDuration(90)).toBe('1 分 30 秒')
    expect(formatDuration(125.7)).toBe('2 分 6 秒')
  })

  it('零与空值不显示', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})

describe('时间格式化', () => {
  it('带时区标注', () => {
    const text = formatDateTime(1775290400)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/)
  })

  it('零值返回占位', () => {
    expect(formatDateTime(0)).toBe('未知时间')
  })
})

describe('引用角标', () => {
  const message = {
    id: 'm1',
    parentId: null,
    role: 'assistant',
    text: '结论[reference:0]与[reference:1]',
    thinking: [],
    sources: [
      { index: 0, title: 'A', url: 'https://a.example' },
      { index: 1, title: 'B', url: 'https://b.example' },
    ],
    attachments: [],
    insertedAt: 0,
    hidden: false,
  } as Message

  it('相对序号还原成真实链接', () => {
    const linked = linkCitations(message.text, message)
    expect(linked).toContain('[1](https://a.example)')
    expect(linked).toContain('[2](https://b.example)')
    expect(linked).not.toContain('reference:')
  })

  it('找不到对应来源时保留原样，不静默删除', () => {
    const orphan = { ...message, sources: [] } as Message
    expect(linkCitations(message.text, orphan)).toBe(message.text)
  })
})

describe('中英文混排', () => {
  it('数字与中文之间插空格', () => {
    expect(spaceCjk('共38条消息')).toBe('共 38 条消息')
  })

  it('已经是空格的不重复插', () => {
    expect(spaceCjk('共 38 条')).toBe('共 38 条')
  })
})