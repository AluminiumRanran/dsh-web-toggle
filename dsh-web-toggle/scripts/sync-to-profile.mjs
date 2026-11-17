import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把本包的运行期文件同步进 profile 里已安装的那份副本。
 *
 * pnpm 的 `file:` 依赖在这里是**拷贝**而不是软链，所以改完源码不重装时，
 * 这个脚本负责把 index.js / client.js / locale / docs / icon 推过去。
 * 用法：node scripts/sync-to-profile.mjs [profileDir]
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const profileDir = process.argv[2] ?? 'C:/Users/Aluminium/.dsh/profiles/desktop'
const target = join(profileDir, 'node_modules', 'dsh-web-toggle')

assert.ok(existsSync(join(target, 'package.json')), `没有已安装的副本：${target}（先跑 plugin_manager install_bundle）`)

const samePackage = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name
assert.equal(samePackage, 'dsh-web-toggle', '目标目录不是本包，拒绝覆盖')

const files = [
  // The manifest too: it carries the version the shell shows and the export map it
  // resolves, so a stale copy keeps reporting the previous release.
  ['package.json', 'package.json'],
  ['index.js', 'index.js'],
  ['client.js', 'client.js'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['icon.svg', 'icon.svg'],
  ['README.md', 'README.md'],
  ['locale/en.json', 'locale/en.json'],
  ['locale/zh.json', 'locale/zh.json'],
  ['docs/DETAIL.md', 'docs/DETAIL.md'],
  ['docs/VERIFY.md', 'docs/VERIFY.md'],
]

for (const [source, destination] of files) {
  const from = join(packageDir, source)
  const to = join(target, destination)
  if (!existsSync(from)) {
    console.log(`skip ${source}（不存在）`)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  const identical = readFileSync(from).equals(readFileSync(to))
  assert.ok(identical, `${destination} 同步后仍不一致`)
  console.log(`ok ${destination}`)
}

console.log(`\n已同步到 ${target}\n刷新浏览器（以及必要时重启 DSH）后生效。`)
