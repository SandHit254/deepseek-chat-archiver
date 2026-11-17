import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 依次构建三个 IIFE 入口，再补上 manifest 与图标。
 *
 * 顺序有意义：content 先跑（负责清空 dist），background / pageHook 追加。
 */
const targets = ['content', 'background', 'pageHook']
// 注意：本文件在 scripts/ 下，项目根目录要往上一级
const root = resolve(import.meta.dirname, '..')

for (const target of targets) {
  const env = { ...process.env, BUILD_TARGET: target }
  const result = spawnSync('npx', ['vite', 'build'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// manifest 里的版本号以 package.json 为准，避免两处手改不同步
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'))
manifest.version = pkg.version
writeFileSync(join(root, 'dist/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

/*
 * 静态资源：只需要图标。
 *
 * panel.html / panel.css 的内容已在构建时内联进 content.js（见 vite.config.ts
 * 的 __PANEL_HTML__ / __PANEL_CSS__），不再复制到 dist——否则包里会多两个
 * 永远用不到的文件，徒增困惑。
 */
const iconsFrom = join(root, 'public', 'icons')
const iconsTo = join(root, 'dist', 'icons')
mkdirSync(dirname(iconsTo), { recursive: true })
cpSync(iconsFrom, iconsTo, { recursive: true })

console.warn('\n构建完成 → dist/')
