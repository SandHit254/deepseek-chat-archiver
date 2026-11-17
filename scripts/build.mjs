import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 依次构建三个 IIFE 入口，再补上 manifest、图标与面板 HTML。
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

// 静态资源：面板页面、样式、图标
for (const item of ['panel.html', 'panel.css', 'icons']) {
  const from = join(root, 'public', item)
  const to = join(root, 'dist', item)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

console.warn('\n构建完成 → dist/')