import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * MV3 的三个产物入口各自独立构建。
 *
 * 为什么不用多入口一次构建：content script 不能是 ES module，
 * 必须打平成无 import/export 的 IIFE。多入口 es 构建会抽出共享 chunk
 * 并生成 import 语句，content script 会直接报错。所以按 target 分别
 * 用 lib 模式出 IIFE，互不干扰。
 *
 * 用法：BUILD_TARGET=content|background|pageHook npm run build
 * 日常用 npm run build 会由 scripts/build.mjs 依次跑三遍。
 */
const ENTRIES = {
  content: 'src/content/index.ts',
  background: 'src/background/index.ts',
  pageHook: 'src/content/pageHook.ts',
} as const

type Target = keyof typeof ENTRIES

const target = (process.env.BUILD_TARGET ?? 'content') as Target
const entry = ENTRIES[target]

if (!entry) {
  throw new Error(`未知 BUILD_TARGET：${target}（可选：${Object.keys(ENTRIES).join(' | ')}）`)
}

const root = import.meta.dirname

/**
 * 面板 HTML 片段与样式在构建时内联进 content script。
 *
 * 为什么不运行时读取：content script 要往 Shadow DOM 里挂面板，运行时
 * 去 fetch chrome.runtime.getURL('panel.html') 会引入异步依赖与权限问题；
 * 内联成字符串字面量最简单，也避免多一次网络往返。
 *
 * 提取规则：取 <body> 内部内容，并剔除 <script> 标签——脚本由打包产物提供。
 */
function loadPanelAssets(): { html: string; css: string } {
  const htmlSource = readFileSync(resolve(root, 'public/panel.html'), 'utf8')
  const css = readFileSync(resolve(root, 'public/panel.css'), 'utf8')

  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(htmlSource)
  if (!bodyMatch) throw new Error('panel.html 缺少 <body>，无法提取面板片段')

  const html = bodyMatch[1]!
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .trim()

  return { html, css }
}

const panelAssets = target === 'content' ? loadPanelAssets() : { html: '', css: '' }

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  /*
   * 关掉 public 目录的自动拷贝。
   *
   * vite 默认会把 public/ 整个复制到 dist/，但我们的 manifest、图标由
   * scripts/build.mjs 显式处理，而 panel.html / panel.css 已内联进
   * content.js——自动拷贝只会往最终包里塞冗余文件。
   */
  publicDir: false,
  define: {
    __PANEL_HTML__: JSON.stringify(panelAssets.html),
    __PANEL_CSS__: JSON.stringify(panelAssets.css),
  },
  build: {
    outDir: 'dist',
    // 第一个 target 负责清空目录，后续 target 追加产物
    emptyOutDir: target === 'content',
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve(root, entry),
      formats: ['iife'],
      name: `DSA_${target}`,
      fileName: () => `${target}.js`,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})