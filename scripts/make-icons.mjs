import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 生成扩展图标。
 *
 * 为什么脚本化生成：手写 PNG 二进制不可维护，而为 4 个小图标引入绘图库
 * 也不值当。这里直接按 PNG 规范拼像素，用 zlib 压 IDAT。
 *
 * 图形：圆角方形底（主色 #3b82f6）+ 白色向下箭头与托底横线，表达「导出」。
 */

const BRAND = [59, 130, 246]
const WHITE = [255, 255, 255]

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 画一个 size×size 的图标。
 *
 * 用 4x 超采样再降采样，得到平滑边缘——否则小尺寸下圆角与箭头锯齿明显。
 */
function renderIcon(size) {
  const scale = 4
  const big = size * scale
  const pixels = new Uint8Array(big * big * 4)

  const radius = big * 0.22
  const inset = big * 0.02

  const inRoundedSquare = (x, y) => {
    const left = inset
    const top = inset
    const right = big - inset
    const bottom = big - inset
    if (x < left || x > right || y < top || y > bottom) return false
    const corners = [
      [left + radius, top + radius],
      [right - radius, top + radius],
      [left + radius, bottom - radius],
      [right - radius, bottom - radius],
    ]
    if (x > left + radius && x < right - radius) return true
    if (y > top + radius && y < bottom - radius) return true
    return corners.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2)
  }

  // 箭头与托底：按比例定义，保证任何尺寸下视觉一致
  const stemHalfWidth = big * 0.075
  const stemTop = big * 0.26
  const stemBottom = big * 0.52
  const headHalfWidth = big * 0.19
  const headTop = big * 0.46
  const headBottom = big * 0.66
  const baseTop = big * 0.72
  const baseBottom = big * 0.79
  const baseHalfWidth = big * 0.22
  const centerX = big / 2

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const offset = (y * big + x) * 4
      if (!inRoundedSquare(x, y)) {
        pixels[offset + 3] = 0
        continue
      }

      pixels[offset] = BRAND[0]
      pixels[offset + 1] = BRAND[1]
      pixels[offset + 2] = BRAND[2]
      pixels[offset + 3] = 255

      const isStem = Math.abs(x - centerX) <= stemHalfWidth && y >= stemTop && y <= stemBottom
      // 箭头是向下的三角形：越往下允许的半宽越小
      const inHead = y >= headTop && y <= headBottom
        && Math.abs(x - centerX) <= headHalfWidth * (1 - (y - headTop) / (headBottom - headTop))
      const isBase = y >= baseTop && y <= baseBottom && Math.abs(x - centerX) <= baseHalfWidth

      if (isStem || inHead || isBase) {
        pixels[offset] = WHITE[0]
        pixels[offset + 1] = WHITE[1]
        pixels[offset + 2] = WHITE[2]
      }
    }
  }

  // 降采样到目标尺寸（按 alpha 加权，避免边缘发灰）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const sourceOffset = ((y * scale + dy) * big + (x * scale + dx)) * 4
          const alpha = pixels[sourceOffset + 3] / 255
          r += pixels[sourceOffset] * alpha
          g += pixels[sourceOffset + 1] * alpha
          b += pixels[sourceOffset + 2] * alpha
          a += alpha
        }
      }
      const total = scale * scale
      const target = (y * size + x) * 4
      if (a === 0) {
        out[target + 3] = 0
        continue
      }
      out[target] = Math.round(r / a)
      out[target + 1] = Math.round(g / a)
      out[target + 2] = Math.round(b / a)
      out[target + 3] = Math.round((a / total) * 255)
    }
  }

  // 按 PNG 规范组装：每行前加一个 filter byte（0 = None）
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0
    out.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const root = import.meta.dirname
const outDir = resolve(root, '../public/icons')
mkdirSync(outDir, { recursive: true })

for (const size of [16, 32, 48, 128]) {
  const file = resolve(outDir, `icon${size}.png`)
  writeFileSync(file, renderIcon(size))
  console.warn(`生成 icon${size}.png`)
}