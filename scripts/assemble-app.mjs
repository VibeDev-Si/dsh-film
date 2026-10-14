#!/usr/bin/env node
/**
 * Put the built ToonFlow app into this plugin's `apps/toonflow/`.
 *
 * Run the ToonFlow build first (in the ToonFlow checkout):
 *   bun run build && bun run build:nodes
 * then, here, naming that checkout (there is no default: a build must never
 * depend on a path that exists only on one developer's machine):
 *   node scripts/assemble-app.mjs <toonflow-directory>
 * or: TOONFLOW_SOURCE=<toonflow-directory> node scripts/assemble-app.mjs
 *
 * The layout the packaged server expects is `<root>/build/{server,web,tools,nodes,ext,providers,skills}`,
 * with `build/server/film.js` as the entry the plugin starts. The plugin's own
 * runtime is installed as the platform-specific optional Bun dependency.
 *
 * `vendor/toonflow-extras/` holds third-party nodes and tools that exist in the user's
 * installed desktop app but not in the ToonFlow build; they are copied on top of the
 * assembled `build/nodes` and `build/tools` here, so reassembling never loses them.
 * Their source, hashes, licensing debt and the load-time expectation are in
 * `docs/THIRD-PARTY.md`.
 *
 * `apps/toonflow/` is not committed (it is ~170 MB and rebuilt from ToonFlow); it is
 * packed into the published tarball, so this must run before `npm pack`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workbenchSource } from './workbench-source.mjs'
import { bunRuntimeFor } from './bun-runtime.mjs'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { packageName, executable } = bunRuntimeFor(process.platform, process.arch)
const flags = process.argv.slice(2).filter(argument => argument.startsWith('--'))
const requested = process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? process.env.TOONFLOW_SOURCE
if (requested === undefined || requested.trim() === '') {
  console.error('请给出已构建的 ToonFlow 目录：node scripts/assemble-app.mjs <toonflow-directory> [--unreleased]\n（或设置 TOONFLOW_SOURCE。这里不设默认值，避免依赖某个开发者机器上的路径。）')
  process.exit(1)
}
const source = resolve(requested)
// The commit the build comes from: committed and pushed to the workbench repository, or this is not a release
// (`--unreleased` records local work; verify-package.mjs then refuses the package).
let origin
try {
  origin = workbenchSource(source, { allowUnreleased: flags.includes('--unreleased') })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
const target = join(here, 'apps/toonflow')
const parts = ['server', 'web', 'tools', 'nodes', 'ext', 'providers', 'skills']
/** Not used by the Film entry (it belongs to the desktop/server entry), and a duplicate 21 MB bundle. */
const skip = new Set(['server/index.js'])

const required = [join(source, 'build/server/film.js'), join(source, 'build/web/index.html')]
for (const path of required) {
  if (!existsSync(path)) {
    console.error(`缺少 ${path}\n请先在 ToonFlow 工程里执行：bun run build && bun run build:nodes（目录：${source}）`)
    process.exit(1)
  }
}

const bytes = (directory) => readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .reduce((sum, entry) => sum + statSync(join(entry.parentPath ?? directory, entry.name)).size, 0)

mkdirSync(join(target, 'build'), { recursive: true })
for (const part of parts) {
  const from = join(source, 'build', part)
  if (!existsSync(from)) { console.warn(`跳过 ${part}（ToonFlow 里没有构建）`); continue }
  const to = join(target, 'build', part)
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, filter: (path) => !skip.has(path.slice(source.length + 1).split('\\').join('/').replace(/^build\//, '')) })
}
for (const unwanted of skip) rmSync(join(target, 'build', unwanted), { force: true })

// Third-party extras the user's desktop app has on top of the ToonFlow build.
const vendor = join(here, 'vendor/toonflow-extras')
const extras = []
if (existsSync(vendor)) {
  for (const part of readdirSync(vendor, { withFileTypes: true })) {
    if (!part.isDirectory()) continue
    const from = join(vendor, part.name)
    const to = join(target, 'build', part.name)
    if (!existsSync(to)) { console.warn(`跳过内置第三方包 ${part.name}（组装结果里没有 build/${part.name}）`); continue }
    for (const file of readdirSync(from, { withFileTypes: true })) {
      // Nodes and tools are single files; skills are folders (SKILL.md + references/).
      if (file.isFile()) copyFileSync(join(from, file.name), join(to, file.name))
      else if (file.isDirectory()) { rmSync(join(to, file.name), { recursive: true, force: true }); cpSync(join(from, file.name), join(to, file.name), { recursive: true }) }
      else continue
      extras.push(`build/${part.name}/${file.name}`)
    }
  }
}

// Tools of the removed built-in agent: the VibeDev session has its own
// (ask_user_question, the sidebar browser, web_fetch, web_search). Not shipped;
// the server also removes the seeded copies from older data directories.
const retiredTools = ['askUser', 'browser', 'webFetch', 'webSearch']
for (const name of retiredTools) rmSync(join(target, 'build/tools', `${name}.tool.js`), { force: true })

// The runtime is the official Bun package the plugin depends on (@oven/bun-<platform>-<arch>), installed with it;
// a copy in apps/toonflow/runtime is only placed on request (FILM_PLACE_RUNTIME=1), for a checkout used without installing.
rmSync(join(target, 'runtime'), { recursive: true, force: true })
if (process.env.FILM_PLACE_RUNTIME === '1') {
  const bun = process.env.BUN_PATH ?? execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  mkdirSync(join(target, 'runtime'), { recursive: true })
  copyFileSync(bun, join(target, 'runtime', executable))
}

// Which workbench commit this build is: packed into the npm archive, checked by verify-package.mjs.
writeFileSync(join(target, 'SOURCE.json'), `${JSON.stringify(origin, null, 2)}\n`)

const mb = (value) => `${(value / 1024 / 1024).toFixed(1)} MB`
console.log(`已组装 ${target}`)
console.log(`  来源 ${origin.repository} @ ${origin.commit}${origin.released ? '' : '（未发布的本地构建，不能用于发布）'}`)
for (const part of parts) {
  const directory = join(target, 'build', part)
  if (existsSync(directory)) console.log(`  build/${part.padEnd(10)} ${mb(bytes(directory))}`)
}
const placedRuntime = join(target, 'runtime', executable)
console.log(existsSync(placedRuntime) ? `  runtime/bun  ${mb(statSync(placedRuntime).size)}` : `  runtime      由本机可选依赖 ${packageName} 提供`)
for (const extra of extras) console.log(`  内置第三方包 ${extra}  ${mb(statSync(join(target, extra)).size)}`)
console.log(`合计 ${mb(bytes(target))}`)
