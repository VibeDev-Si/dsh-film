#!/usr/bin/env node
/**
 * Install (or refresh) the plugin into a local directory, atomically.
 *
 *   node scripts/install-app.mjs <install-directory> [package-root]
 *
 * The host loads the plugin from a local directory. Refreshing one in place made
 * the "running artifacts are incomplete (missing build/web/index.html)" error
 * possible: a partially written file (one was even left with a 1985 timestamp)
 * is exactly what the host then refuses to start. So this never writes into the
 * directory the host reads:
 *
 *   1. unpack/assemble the new build into `<install>.new-<time>`;
 *   2. check the build is complete and that every asset its own index.html asks
 *      for is present (that check would have caught the broken install);
 *   3. move the current directory to `<install>.old-<time>`, move the new one into
 *      place, then delete the old one.
 *
 * A running host keeps using the old files until it reloads; the swap itself is
 * two renames, so no reader ever sees a half-written build.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bunRuntimeFor, installedBunRuntime } from './bun-runtime.mjs'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { packageName, executable } = bunRuntimeFor(process.platform, process.arch)
const target = process.argv[2]
if (target === undefined || target.trim() === '') {
  console.error('用法：node scripts/install-app.mjs <安装目录> [包根目录]\n（包根目录默认是本仓库；也可以给一个 .tgz 或已解包的 package 目录。）')
  process.exit(1)
}
const install = resolve(target)
const source = process.argv[3] === undefined ? here : resolve(process.argv[3])

/** Copy the package into a staging directory, from a directory or a tarball. */
function stage(destination) {
  if (source.toLowerCase().endsWith('.tgz')) {
    execFileSync('tar', ['-xzf', source, '-C', destination], { stdio: 'inherit' })
    return join(destination, 'package')
  }
  if (existsSync(join(source, 'package.json')) && basename(source) === 'package') {
    cpSync(source, destination, { recursive: true })
    return destination
  }
  // This checkout: copy what `npm pack` would ship, so the install matches the package.
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  for (const entry of [...(manifest.files ?? []), 'package.json']) {
    const from = join(source, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(destination, entry), { recursive: true })
  }
  return destination
}

/** Everything the host and the app itself need, and every asset index.html asks for. */
function inspect(root) {
  const web = join(root, 'apps/toonflow/build/web')
  const html = readFileSync(join(web, 'index.html'), 'utf8')
  const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1])
  const missing = referenced.filter(relative => !existsSync(join(web, relative)))
  const required = [
    'package.json', 'lib/index.js', 'client/client.js', 'cordis.patch.yml',
    'apps/toonflow/build/server/film.js', 'apps/toonflow/build/web/index.html',
  ]
  const placedRuntime = join(root, 'apps/toonflow/runtime', executable)
  return {
    runtime: existsSync(placedRuntime) ? placedRuntime : installedBunRuntime(root),
    missingFiles: required.filter(relative => !existsSync(join(root, relative))),
    missingAssets: missing,
    assets: referenced.length,
    bytes: readdirSync(join(root, 'apps/toonflow'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .reduce((sum, entry) => sum + statSync(join(entry.parentPath ?? '', entry.name)).size, 0),
  }
}

const staging = `${install}.new-${Date.now()}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
const staged = stage(staging)
let report = inspect(staged)
if (report.missingFiles.length > 0 || report.missingAssets.length > 0) {
  console.error('✗ 新产物不完整，未安装（原目录保持不变）')
  for (const file of report.missingFiles) console.error(`  缺少 ${file}`)
  for (const asset of report.missingAssets) console.error(`  index.html 引用的资源不存在：${asset}`)
  rmSync(staging, { recursive: true, force: true })
  process.exit(1)
}
if (report.runtime === undefined) {
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--omit=peer', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'],
      { cwd: staged, stdio: 'inherit', shell: process.platform === 'win32' })
    report = inspect(staged)
  } catch (error) {
    console.error(`✗ 无法安装本机 Bun 依赖 ${packageName}：${error instanceof Error ? error.message : String(error)}`)
    rmSync(staging, { recursive: true, force: true })
    process.exit(1)
  }
}
if (report.runtime === undefined || !existsSync(report.runtime)) {
  console.error(`✗ 缺少本机 Bun 运行时 ${packageName}，未安装（原目录保持不变）`)
  rmSync(staging, { recursive: true, force: true })
  process.exit(1)
}
console.log(`✓ 新产物完整：${report.assets} 个入口资源全部存在，${(report.bytes / 1024 / 1024).toFixed(1)} MB`)

/** Windows answers these when something holds a folder open (a file watch, an Explorer window). */
const locked = (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)

/**
 * Put `from` where `to` is, moving the old one to `aside`.
 *
 * The whole folder is renamed when it can be. When something holds it open —
 * a running host watching a folder inside it blocks renaming that folder and every
 * parent — this goes one level down and swaps the children instead, so each file
 * still changes in a single rename and only the held folders stay in place (with
 * new contents).
 * @returns how many folders had to be swapped by their children.
 */
function swap(from, to, aside) {
  try {
    renameSync(to, aside)
  } catch (error) {
    if (!locked(error)) throw error
    if (!statSync(to).isDirectory() || !statSync(from).isDirectory()) throw error
    mkdirSync(aside, { recursive: true })
    let held = 1
    const incoming = new Set(readdirSync(from))
    for (const name of readdirSync(to)) {
      if (!incoming.has(name)) renameSync(join(to, name), join(aside, name))
    }
    for (const name of incoming) {
      const target = join(to, name)
      if (existsSync(target)) held += swap(join(from, name), target, join(aside, name))
      else renameSync(join(from, name), target)
    }
    return held
  }
  renameSync(from, to)
  return 0
}

// Swap by rename, keeping the previous install until the new one is in place.
const backup = `${install}.old-${Date.now()}`
let held = 0
if (existsSync(install)) {
  try {
    held = swap(staged, install, backup)
  } catch (error) {
    console.error(`✗ 替换失败：${error instanceof Error ? error.message : String(error)}`)
    console.error(`  旧文件在 ${backup}，新产物在 ${staged}；关掉 VibeDev Next 后重新运行本脚本即可。`)
    process.exit(1)
  }
} else {
  renameSync(staged, install)
}
rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
const after = inspect(install)
if (after.missingFiles.length > 0 || after.missingAssets.length > 0 || after.runtime === undefined || !existsSync(after.runtime)) {
  console.error('✗ 安装后的目录不完整：', [...after.missingFiles, ...after.missingAssets].join(', '))
  process.exit(1)
}
console.log(held === 0
  ? `✓ 已安装到 ${install}`
  : `✓ 已安装到 ${install}（有 ${held} 个文件夹正被占用，已逐个替换其中的内容）`)
