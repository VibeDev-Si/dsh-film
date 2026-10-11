#!/usr/bin/env node
/**
 * Prove that a built package actually runs — the artifact, not the source tree.
 *
 *   node scripts/verify-package.mjs                     # this checkout's apps/toonflow
 *   node scripts/verify-package.mjs dsh-film-0.5.0.tgz
 *   node scripts/verify-package.mjs <unpacked-package-directory>
 *
 * It starts the packaged Film entry with the bundled runtime, a throwaway data
 * directory and a bridge that is deliberately unreachable, then checks the three
 * things a local install must get right:
 *
 *   1. the entry becomes ready and prints its loopback URL;
 *   2. the page is not open to other programs (no session, no data: 401);
 *   3. the host's session link trades its token for a page cookie (303).
 *
 * Models are not exercised (they need a signed-in VibeDev account). Exit code 0\n * means the artifact boots and gates the page.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const argument = process.argv[2]
const scratch = mkdtempSync(join(tmpdir(), 'film-verify-'))
let root = resolve('apps/toonflow')
/** Where the plugin's dependencies resolve from (the runtime package). */
let packageDirectory = resolve('.')
if (argument !== undefined) {
  if (argument.toLowerCase().endsWith('.tgz')) {
    // Installed as a user gets it: the archive plus its dependencies (the Bun runtime package).
    console.log(`安装 ${argument}（含依赖）…`)
    // A project of its own, so npm installs here and never into a parent folder.
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'film-verify', private: true }))
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund', resolve(argument)],
      { cwd: scratch, stdio: 'inherit', shell: process.platform === 'win32' })
    const name = JSON.parse(execFileSync('tar', ['-xOzf', resolve(argument), 'package/package.json'], { encoding: 'utf8' })).name
    packageDirectory = join(scratch, 'node_modules', name)
    root = join(packageDirectory, 'apps/toonflow')
  } else {
    root = resolve(argument, 'apps/toonflow')
    if (!existsSync(root)) root = resolve(argument)
    packageDirectory = resolve(argument)
  }
}

const entry = join(root, 'build/server/film.js')
const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
const placed = join(root, 'runtime', executable)
/** The runtime the plugin starts: one placed in apps/toonflow/runtime, else the installed @oven/bun-* package. */
function installedRuntime() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  try {
    const manifest = createRequire(join(packageDirectory, 'package.json')).resolve(`@oven/bun-${platform}-${process.arch}/package.json`)
    return join(dirname(manifest), 'bin', executable)
  } catch {
    return join(packageDirectory, 'node_modules', `@oven/bun-${platform}-${process.arch}`, 'bin', executable)
  }
}
const runtime = existsSync(placed) ? placed : installedRuntime()
let missing = false
for (const [what, path] of [['Film 入口', entry], ['Bun 运行时', runtime], ['Web 产物', join(root, 'build/web/index.html')]]) {
  if (!existsSync(path)) { console.error(`✗ 缺少${what}：${path}`); missing = true; continue }
  console.log(`✓ ${what}：${path}`)
}
if (missing) process.exit(1)

// The Host loads the client half under the package name and waits for a registration with exactly
// that id; any other id never activates and the whole web boot fails (dsh-film 0.5.0–0.5.2).
if (existsSync(join(packageDirectory, 'client/client.js'))) {
  const packageName = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).name
  const registered = /^window\.__ModuleLoader__\.load\(\{\s*id: "([^"]+)"/.exec(readFileSync(join(packageDirectory, 'client/client.js'), 'utf8'))?.[1]
  if (registered !== packageName) {
    console.error(`✗ 客户端注册 id 是 "${registered ?? '（没有）'}"，包名是 "${packageName}"：宿主按包名加载，界面会启动失败`)
    process.exit(1)
  }
  console.log(`✓ 客户端按包名注册：${packageName}`)
}

// The page's own entry files must exist. A stale index.html pointing at a bundle
// that is no longer there is a blank page, and it is exactly what a half-written
// install produced once — so this is checked before the server is even started.
const page = readFileSync(join(root, 'build/web/index.html'), 'utf8')
const referenced = [...page.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1])
const broken = referenced.filter(relative => !existsSync(join(root, 'build/web', relative)))
if (broken.length > 0) {
  console.error(`✗ Web 产物入口不完整：index.html 引用的 ${broken.length}/${referenced.length} 个文件不存在`)
  for (const relative of broken.slice(0, 5)) console.error(`  ${relative}`)
  process.exit(1)
}
console.log(`✓ Web 入口资源齐全（${referenced.length} 个引用全部存在）`)

// The bundle is what the browser actually runs, so the checks below look at the
// built chunks, not at this repository's sources. What a "direct to canvas"
// install must have carried through the build: the entry that reads the session's
// workspace, the request that opens its project, the project center, and the
// channel to the host tab (ready / save-before-close / reveal / preview).
const assetsDirectory = join(root, 'build/web/assets')
// The page builds these as relative paths (`apiPath("workspaces/film/…")`), so look for the route part only.
const needles = ['filmWorkspace', 'workspaces/film/prepare', 'workspaces/film/projects', 'vibedev-film']
const wired = []
for (const name of readdirSync(assetsDirectory)) {
  if (!name.endsWith('.js') || statSync(join(assetsDirectory, name)).size > 20 * 1024 * 1024) continue
  const text = readFileSync(join(assetsDirectory, name), 'utf8')
  for (const needle of needles) if (text.includes(needle) && !wired.includes(needle)) wired.push(needle)
}
if (wired.length !== needles.length) {
  console.error(`✗ Web 产物缺少"直接进画布"入口（找到 ${wired.length}/${needles.length}：${wired.join('、') || '无'}）`)
  process.exit(1)
}
console.log('✓ 直接进画布入口已打进 Web 产物（工作区入口、项目准备、项目中心、宿主通道）')
const dataDirectory = join(scratch, 'data')
const webToken = 'a'.repeat(64)
const child = spawn(runtime, [entry], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    FILM_ACCOUNT_MODE: '1',
    FILM_APP_ROOT: root,
    FILM_BRIDGE_URL: 'http://127.0.0.1:9',
    FILM_BRIDGE_TOKEN: 'b'.repeat(64),
    FILM_WEB_TOKEN: webToken,
    TOONFLOW_DATA_DIR: dataDirectory,
  },
})

/**
 * Finish the run without an abrupt teardown.
 *
 * `process.exit()` while the child's stdio pipes are still closing trips a libuv
 * assertion on Windows (`UV_HANDLE_CLOSING`), which turned a passing run into
 * exit code 1. So: kill the child, drain and detach its pipes, wait for it to be
 * gone, then let the event loop empty out on its own. `process.exitCode` — not
 * `process.exit()` — carries the result. The unref'd watchdogs are only there so
 * a stuck handle cannot hang the caller for long.
 */
let finished = false
async function stop(code) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  lines.close()
  child.kill()
  await new Promise((done) => {
    const giveUp = setTimeout(done, 5_000)
    child.once('exit', () => { clearTimeout(giveUp); done() })
  })
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.removeAllListeners()
  // A last close() may still be in flight; retrying beats failing the run here.
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  catch (error) { console.error(`提示：临时目录未能删除（不影响结论）：${scratch}（${error instanceof Error ? error.message : String(error)}）`) }
  process.exitCode = code
  setTimeout(() => {
    console.error('✗ 收尾超时：仍有句柄未释放，强制退出')
    process.exit(code === 0 ? 1 : code)
  }, 10_000).unref()
}

const fail = (message, tail = '') => {
  console.error(`✗ ${message}${tail === '' ? '' : `\n--- 服务端输出 ---\n${tail}`}`)
  void stop(1)
}

const tail = []
child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/)) if (line.trim() !== '') tail.push(line)
  if (tail.length > 20) tail.splice(0, tail.length - 20)
})

const timer = setTimeout(() => fail('启动超时（60 秒）', tail.slice(-10).join('\n')), 60_000)
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  let ready
  try { ready = JSON.parse(line).filmReady } catch { return }
  if (typeof ready !== 'string') return
  clearTimeout(timer)
  lines.close()
  void (async () => {
    try {
      console.log(`✓ 就绪：${ready}`)
      const unauthorized = await fetch(`${ready}/api/settings/get`)
      if (unauthorized.status !== 401) return fail(`无会话访问设置应 401，实际 ${unauthorized.status}`)
      console.log('✓ 无会话访问被拒（401）')
      const bootstrap = await fetch(`${ready}/?filmAccess=${webToken}`, { redirect: 'manual' })
      if (bootstrap.status !== 303) return fail(`会话链接应 303，实际 ${bootstrap.status}`)
      if (!(bootstrap.headers.get('set-cookie') ?? '').includes(webToken)) return fail('会话链接没有种下页面 Cookie')
      console.log('✓ 会话链接换取页面 Cookie（303）')
      console.log(`\n通过：${root}`)
      void stop(0)
    } catch (error) {
      fail(`检查失败：${error instanceof Error ? error.message : String(error)}`, tail.slice(-10).join('\n'))
    }
  })()
})
child.once('exit', (code) => { if (finished) return; clearTimeout(timer); fail(`服务在就绪前退出（${code}）`, tail.slice(-10).join('\n')) })
