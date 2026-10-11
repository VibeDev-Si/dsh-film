#!/usr/bin/env node
/**
 * Open the packaged workbench in a real (headless) browser, the way the sidebar
 * tab does, and check what the user would see.
 *
 *   node scripts/browser-check.mjs [app-root] [browser-exe]
 *
 * The server tests call routes directly, so they cannot see mistakes that only
 * happen in the page — a request address the page builds wrongly (the doubled
 * `/s/<token>/s/<token>/api/…` that showed "Request failed with status code 404"),
 * nodes that fail to load (the empty "添加节点" menu), a page that never mounts.
 * This drives Edge/Chrome over the DevTools protocol:
 *
 *   1. the session link with `filmWorkspace=<a workspace with a file of the user in it>`
 *      → the canvas renders, `VibeDev Film/画布1.json` is created, the user's file
 *        is untouched, node scripts are loaded;
 *   2. the project center → it renders and lists that project;
 *   and in both, no request to this server answered 4xx/5xx, and no page error.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(process.argv[2] ?? join(here, 'apps/toonflow'))
const browser = process.argv[3] ?? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
].find(path => existsSync(path))
if (browser === undefined) { console.log('跳过：本机没有 Edge / Chrome'); process.exit(0) }

const scratch = mkdtempSync(join(tmpdir(), 'film-browser-check-'))
// Same shape as the real default (`~/.vibedev/film-studio/data`): a dot-directory in
// the path once made every node script 404, which a plain temp path did not show.
const data = join(scratch, '.vibedev', 'film-studio', 'data')
// The user's workspace has dot-folders too (.agents, .claude): keep one in the test.
const workspace = join(scratch, '我的工作区')
const profile = join(scratch, 'profile')
for (const directory of [data, workspace]) rmSync(directory, { recursive: true, force: true })
await import('node:fs/promises').then(fs => Promise.all([fs.mkdir(data, { recursive: true }), fs.mkdir(workspace, { recursive: true })]))
// FILM_CHECK_DATA_FROM=<a real data directory>: check against a copy of it (never the original).
if (process.env.FILM_CHECK_DATA_FROM) {
  const { cpSync } = await import('node:fs')
  cpSync(process.env.FILM_CHECK_DATA_FROM, data, { recursive: true, filter: (source) => !/[\\/](logs|session\.lock)$/.test(source) })
}
writeFileSync(join(workspace, 'notes.md'), '# 用户自己的文件\n')

const children = []
let failed = false
const fail = (message) => { failed = true; console.error(`✗ ${message}`) }
const pass = (message) => { console.log(`✓ ${message}`) }
const cleanup = () => {
  for (const child of children) { try { child.kill() } catch { /* gone */ } }
  setTimeout(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }, 500).unref()
}
process.on('exit', cleanup)
const watchdog = setTimeout(() => { fail('超时（120 秒）'); process.exit(1) }, 120_000)
watchdog.unref()

const freePort = () => new Promise((done) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)) }) })
const sleep = (ms) => new Promise(resume => setTimeout(resume, ms))

// 0. A stand-in for the plugin's bridge: media models through the account plugin's
//    media service (none here), and 帮写 answered by "the conversation's model" —
//    recording what the page sent, so the brief itself is checked.
const { createServer: createHttpServer } = await import('node:http')
const written = []
const bridge = createHttpServer((request, response) => {
  if (request.method === 'GET' && request.url === '/catalog') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: [], media: [] }))
    return
  }
  if (request.method === 'POST' && request.url === '/write-prompt') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try { written.push(JSON.parse(body)) } catch { written.push({ unreadable: true }) }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ prompt: '雨夜，林夏推门而入，镜头缓慢推近。', provider: 'vibedev-gateway', model: 'deepseek-v4', imagesShown: 0 }))
    })
    return
  }
  response.writeHead(503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'not in this check' } }))
})
await new Promise(done => bridge.listen(0, '127.0.0.1', done))
bridge.unref()
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`

// 1. The workbench server, exactly as the plugin starts it.
const token = 'e'.repeat(64)
const server = spawn(join(root, 'runtime', process.platform === 'win32' ? 'bun.exe' : 'bun'), [join(root, 'build/server/film.js')], {
  cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', FILM_ACCOUNT_MODE: '1', FILM_APP_ROOT: root, FILM_BRIDGE_URL: bridgeUrl, FILM_BRIDGE_TOKEN: 'b'.repeat(64), FILM_WEB_TOKEN: token, FILM_CONTROL_TOKEN: 'c'.repeat(64), FILM_PARENT_PIPE: '1', TOONFLOW_DATA_DIR: data },
})
children.push(server)
server.stderr.resume()
const origin = await new Promise((done, reject) => {
  let buffer = ''
  server.stdout.on('data', (chunk) => { buffer += chunk; const match = /"filmReady":"([^"]+)"/.exec(buffer); if (match) done(match[1]) })
  server.once('exit', () => { reject(new Error('工作台服务没有启动')) })
})

// 2. The browser, driven over the DevTools protocol.
const debugPort = await freePort()
const edge = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true })
children.push(edge)
let version
for (let attempt = 0; attempt < 100 && version === undefined; attempt++) {
  try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json() } catch { await sleep(200) }
}
if (version === undefined) { fail('浏览器没有启动'); process.exit(1) }

async function openPage(url) {
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject })
  let next = 0
  const waiting = new Map()
  const problems = []
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) { waiting.get(message.id)?.(message); waiting.delete(message.id); return }
    if (message.method === 'Network.responseReceived') {
      const { url: address, status } = message.params.response
      // `/favicon.ico` is the browser's own request for a top-level page; a frame never makes it.
      // `mkdir` answers 409 for a folder that exists; the upload treats that as success.
      const expected = address.endsWith('/favicon.ico') || (status === 409 && /\/api\/workspaces\/files\/mkdir/.test(address))
      if (address.startsWith(origin) && status >= 400 && !expected) problems.push(`HTTP ${status} ${address.replaceAll(token, '<令牌>').slice(origin.length)}`)
    } else if (message.method === 'Runtime.exceptionThrown') {
      problems.push(`页面异常：${message.params.exceptionDetails.exception?.description?.split('\n')[0] ?? message.params.exceptionDetails.text}`)
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push(`控制台错误：${message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 200)}`)
    }
  }
  const send = (method, params = {}) => new Promise((done) => { const id = ++next; waiting.set(id, done); socket.send(JSON.stringify({ id, method, params })) })
  await send('Network.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
  return { evaluate, problems, close: () => { socket.close() } }
}

const waitFor = async (page, expression, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true
    await sleep(300)
  }
  return false
}

try {
  // 2a. Straight into the workspace's canvas, as the sidebar tab opens it.
  const canvas = await openPage(`${origin}/s/${token}/?filmWorkspace=${encodeURIComponent(workspace)}&filmSession=browser-check-session`)
  if (await waitFor(canvas, `!!document.querySelector('.vue-flow__pane')`, 45_000)) pass('画布已渲染（直接进入工作区的项目）')
  else fail(`画布没有出现；页面停在：${await canvas.evaluate(`location.hash + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)`)}`)
  const project = join(workspace, 'VibeDev Film')
  if (existsSync(join(project, '画布1.json'))) pass('已在工作区下建好 VibeDev Film/画布1.json')
  else fail('工作区下没有建出 VibeDev Film/画布1.json')
  const rootEntries = readdirSync(workspace).sort()
  if (JSON.stringify(rootEntries) === JSON.stringify(['VibeDev Film', 'notes.md'].sort()) && readFileSync(join(workspace, 'notes.md'), 'utf8') === '# 用户自己的文件\n') pass('工作区根目录只多了 VibeDev Film，用户文件未改动')
  else fail(`工作区根目录内容不符（应为 VibeDev Film、notes.md）：${rootEntries.join(', ')}`)
  // Every node seeded into the data directory must load — not just "some".
  const seeded = readdirSync(join(data, 'nodes')).filter(name => name.endsWith('.umd.js'))
  if (await waitFor(canvas, `Object.keys(window.toonflowNodes ?? {}).length >= ${seeded.length}`, 30_000)) pass(`节点脚本全部加载（${seeded.length} 个）`)
  else {
    const loaded = await canvas.evaluate('Object.keys(window.toonflowNodes ?? {})') ?? []
    const missing = seeded.map(name => name.slice(0, -'.umd.js'.length)).filter(name => !loaded.includes(name))
    fail(`节点脚本没有全部加载（${loaded.length}/${seeded.length}，缺：${missing.join(', ') || '?'}）`)
  }
  // What the user actually sees: right-click the canvas → 添加节点 → the node list.
  const menu = await canvas.evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pane = document.querySelector('.vue-flow__pane');
    if (!pane) return { error: 'no pane' };
    const box = pane.getBoundingClientRect();
    pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    await sleep(600);
    const items = () => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(item => item.offsetParent !== null);
    const add = items().find(item => item.innerText.trim() === '添加节点');
    if (!add) return { error: '右键菜单里没有"添加节点"：' + items().map(item => item.innerText.trim()).join('|') };
    const before = items().map(item => item.innerText.trim());
    add.click();
    await sleep(600);
    const after = items().map(item => item.innerText.trim());
    return { before, after, nodes: after.filter(text => text && !before.includes(text) && !['添加节点', '返回操作菜单'].includes(text)) };
  })()`) ?? {}
  if (process.env.FILM_CHECK_DEBUG) console.log('菜单：', JSON.stringify(menu))
  if (menu.error !== undefined) fail(menu.error)
  else if ((menu.nodes ?? []).length >= seeded.length) pass(`右键"添加节点"列出 ${menu.nodes.length} 个节点：${menu.nodes.join('、')}`)
  else fail(`右键"添加节点"只有 ${(menu.nodes ?? []).length} 个：${(menu.nodes ?? []).join('、') || '（空）'}`)
  // Add a 视频生成 node from that menu: its "VibeDev 帮写" star sits right before the send button.
  const star = await canvas.evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find(entry => entry.offsetParent !== null && entry.innerText.trim() === '视频生成');
    if (!item) return { error: '菜单里没有"视频生成"' };
    item.click();
    for (let i = 0; i < 40 && !document.querySelector('.writeStar'); i++) await sleep(250);
    const button = document.querySelector('.writeStar');
    if (!button) return { error: '视频生成节点里没有帮写星星' };
    const next = button.nextElementSibling;
    const a = button.getBoundingClientRect(), b = next?.getBoundingClientRect();
    return { label: button.getAttribute('aria-label'), nextIsSend: !!next?.classList.contains('sendButton'), gap: b ? Math.round(b.left - a.right) : null,
      oldTextButton: [...document.querySelectorAll('.vue-flow__node button')].some(entry => entry.innerText.trim() === 'VibeDev 写') };
  })()`) ?? {}
  if (star.error !== undefined) fail(star.error)
  else if (star.label === 'VibeDev 帮写' && star.nextIsSend && star.gap !== null && star.gap >= 0 && star.gap <= 12 && !star.oldTextButton) pass(`视频生成节点：帮写星星紧挨发送按钮（间距 ${star.gap}px），旧的"VibeDev 写"已去掉`)
  else fail(`帮写星星位置不对：${JSON.stringify(star)}`)
  // Click it: the page sends the node brief (via the workbench server, which adds the
  // conversation id from the link) and the answer lands in the editor.
  const filled = await canvas.evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const button = document.querySelector('.writeStar');
    if (!button) return { error: 'no star' };
    button.click();
    for (let i = 0; i < 40; i++) {
      const editor = button.closest('.vue-flow__node')?.querySelector('.promptInput');
      if (editor && editor.innerText.includes('林夏推门而入')) return { ok: true };
      await sleep(250);
    }
    return { error: '输入框里没有出现写好的提示词：' + (button.closest('.vue-flow__node')?.querySelector('.promptInput')?.innerText ?? '').slice(0, 80) };
  })()`) ?? {}
  const sent = written.at(-1) ?? {}
  if (filled.error !== undefined) fail(`帮写：${filled.error}`)
  else if (sent.kind === 'video' && sent.node === '视频生成' && sent.sessionId === 'browser-check-session' && sent.canvas?.name) pass(`帮写：写好的提示词填进了输入框；简报是视频节点、带对话 id、画布「${sent.canvas.name}」`)
  else fail(`帮写的简报不对：${JSON.stringify(sent).slice(0, 300)}`)
  // What the user did when it failed: drop files onto the canvas. One image, one text file.
  const dropped = await canvas.evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
    await sleep(300);
    const pane = document.querySelector('.vue-flow__pane');
    const before = document.querySelectorAll('.vue-flow__node').length;
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], '镜头.png', { type: 'image/png' }));
    transfer.items.add(new File(['第一场：雨夜。'], '粘贴文本.txt', { type: 'text/plain' }));
    const box = pane.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + box.width / 3, clientY: box.top + box.height / 3 };
    pane.dispatchEvent(new DragEvent('dragover', at));
    pane.dispatchEvent(new DragEvent('drop', at));
    for (let i = 0; i < 40 && document.querySelectorAll('.vue-flow__node').length < before + 2; i++) await sleep(250);
    const messages = [...document.querySelectorAll('.el-message')].map(item => item.innerText.trim());
    return { added: document.querySelectorAll('.vue-flow__node').length - before, messages };
  })()`) ?? {}
  if (dropped.added >= 2 && !(dropped.messages ?? []).some(text => text.includes('基础节点'))) pass(`拖入图片和文本文件：画布新增 ${dropped.added} 个节点`)
  else fail(`拖入文件后新增 ${dropped.added ?? 0} 个节点；提示：${(dropped.messages ?? []).join(' | ') || '（无）'}`)
  await sleep(1500)
  if (canvas.problems.length === 0) pass('画布页没有失败的请求或页面错误')
  else for (const problem of [...new Set(canvas.problems)]) fail(`画布页：${problem}`)
  canvas.close()

  // 2b. The project center.
  const center = await openPage(`${origin}/s/${token}/#/home`)
  if (await waitFor(center, `document.body.innerText.includes('项目中心') && !document.body.innerText.includes('正在查找')`, 30_000)) pass('项目中心已渲染')
  else fail(`项目中心没有出现：${await center.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)`)}`)
  // Settings in account mode: only the interface, general and FFmpeg panels.
  await center.evaluate(`document.querySelector('.pageHeader [aria-label="设置"], .pageHeader [aria-label^="设置"]')?.click()`)
  const expected = ['界面设置', '常规配置', 'FFmpeg']
  if (await waitFor(center, `document.querySelectorAll('.settingsItem').length > 0`, 10_000)) {
    const panels = await center.evaluate(`[...document.querySelectorAll('.settingsItem')].map(item => item.innerText.trim())`) ?? []
    if (JSON.stringify(panels) === JSON.stringify(expected)) pass(`设置只有：${panels.join('、')}`)
    else fail(`设置面板应为 ${expected.join('、')}，实际：${panels.join('、')}`)
    const text = await center.evaluate(`document.querySelector('.settings')?.innerText ?? ''`) ?? ''
    for (const word of ['赞助', '二维码', '交流群', '插件市场', '文本模型', '关于', '隐私', '检查更新']) if (text.includes(word)) fail(`设置里还有「${word}」`)
  } else fail('设置对话框没有打开')
  await sleep(1500)
  if (center.problems.length === 0) pass('项目中心没有失败的请求或页面错误')
  else for (const problem of [...new Set(center.problems)]) fail(`项目中心：${problem}`)
  center.close()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

console.log(failed ? '\n浏览器检查未通过' : '\n浏览器检查通过')
process.exitCode = failed ? 1 : 0
cleanup()
setTimeout(() => process.exit(process.exitCode), 1500).unref()
