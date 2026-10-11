import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { startBridge, type WorkspaceEntry } from './bridge.js'
import type { MediaService } from './contracts.js'
import type { OneShotServices } from './oneshot.js'

/** The plugin's own directory: `apps/` and the bundled runtime live here, never in a developer checkout. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface RuntimeOptions {
  /**
   * The built ToonFlow to serve. Empty (the normal case) means this plugin's own
   * `apps/toonflow`; a path is for developing against a ToonFlow checkout.
   */
  toonflowDirectory?: string
  /** Film's data directory. Defaults to `<home>/.vibedev/film-studio/data`. */
  dataDirectory?: string
  /**
   * The executable that runs the ToonFlow server. Empty means: a runtime placed in
   * `apps/toonflow/runtime`, else the Bun package installed with the plugin
   * (`@oven/bun-windows-x64`), else the host's own executable.
   */
  runtimePath?: string
}

/** What a built ToonFlow directory must contain to be served. */
interface ToonflowLayout {
  /** The directory to run the server from. */
  root: string
  /** Arguments for the runtime executable. */
  args: readonly string[]
  /** Files that must exist, so a half-built app fails with a clear message. */
  required: readonly string[]
}

function layoutOf(root: string): ToonflowLayout {
  // The packaged app: the Film entry of the server bundle plus the built web app.
  // A ToonFlow checkout keeps the same layout once it has been built.
  return {
    root,
    args: ['build/server/film.js'],
    required: [join(root, 'build/server/film.js'), join(root, 'build/web/index.html')],
  }
}

/** The plugin's own packaged app, when this build shipped one. */
const packagedApp = (): string | undefined => {
  const directory = join(PLUGIN_ROOT, 'apps/toonflow')
  return directory
}

/** The workbench app directory these options run (a dev checkout, or the packaged one). */
export function appRootOf(options: RuntimeOptions): string {
  return resolve(options.toonflowDirectory?.trim() || packagedApp() || '')
}

/** The workbench data directory these options use. */
export function dataDirectoryOf(options: RuntimeOptions): string {
  return resolve(options.dataDirectory?.trim() || join(homedir(), '.vibedev', 'film-studio', 'data'))
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Whether a process with this id is running (signal 0 only asks the question). */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Consecutive failed starts after which a cooldown applies, and how long it lasts. */
export const START_FAILURE_LIMIT = 4
export const START_COOLDOWN_MS = 60_000
/**
 * How long the process stays up after the last workbench tab closed: long enough
 * for the page's final saves (sent while it was closing) to land and for an
 * immediate reopen to reuse the process, short enough that nothing lingers.
 */
export const STOP_GRACE_MS = 3_000

/** What the media service must offer to be usable, named for the error message. */
const MEDIA_METHODS = ['models', 'generateImages', 'startVideo', 'task'] as const

/**
 * Check the account plugin's media service before using it, so a missing or old
 * plugin is reported as such instead of failing later inside a request. (Text
 * needs nothing from the account plugin: it uses the VibeDev conversation's model.)
 * @param services - what the host provided under `vibedevMedia`.
 * @returns the services, once they are known to be usable.
 */
export function requireAccountServices(services: { media?: unknown }): { media: MediaService } {
  const { media } = services
  const missing = (name: string): never => {
    throw new Error(`未找到 VibeDev 账号插件的 ${name} 接口。请安装并启用 VibeDev 账号插件（图片与视频生成需要它）。`)
  }
  if (media === undefined || media === null) missing('vibedevMedia')
  for (const method of MEDIA_METHODS) {
    if (typeof (media as Record<string, unknown>)[method] !== 'function') missing(`vibedevMedia.${method}`)
  }
  return { media: media as MediaService }
}

/**
 * How long to wait before the next start, given how many starts failed in a row.
 * Nothing for the first failure (a transient fault should not delay the user),
 * then a short exponential backoff so a crash loop cannot spin.
 * @param consecutiveFailures - failed starts since the last success.
 * @returns milliseconds to wait.
 */
export function startDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 0
  return Math.min(5_000, 500 * 2 ** (consecutiveFailures - 2))
}

/**
 * One line of the server's own output, safe to show: a bearer token or a long
 * hex secret (bridge and page tokens are 64 hex characters) is replaced, and the
 * line is truncated. Nothing else is interpreted.
 * @param line - a raw output line.
 * @returns the line as it may appear in a message to the user.
 */
export function redactLine(line: string): string {
  return line
    .replace(/(bearer\s+)[\w.-]+/gi, '$1***')
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** How many session logs to keep beside the data directory. */
export const LOG_FILES_KEPT = 20

/** The file that marks which process is serving a data directory. */
export interface SessionLock {
  readonly pid: number
  /** Distinguishes two runtimes inside one process (two host windows share a pid). */
  readonly instanceId: string
  readonly startedAt: string
}

/**
 * Read a lock file's contents. Anything unreadable or incomplete counts as no
 * lock: a corrupt file must not block the user forever.
 * @param text - the lock file's contents.
 * @returns the lock, or undefined when the file says nothing usable.
 */
export function readLock(text: string): SessionLock | undefined {
  try {
    const value = JSON.parse(text) as { pid?: unknown; instanceId?: unknown; startedAt?: unknown }
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
    return {
      pid: value.pid,
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Which log files to delete so that only the newest `keep` remain. Names are
 * `session-<ISO timestamp>.log`, so name order is age order.
 * @param names - the log file names found in the log directory.
 * @param keep - how many to keep.
 * @returns the names to delete.
 */
export function staleLogs(names: readonly string[], keep = LOG_FILES_KEPT): string[] {
  const logs = names.filter(name => name.endsWith('.log')).sort()
  return logs.length <= keep ? [] : logs.slice(0, logs.length - keep)
}

/**
 * The Bun runtime installed with the plugin: the official `@oven/bun-<platform>-<arch>`
 * package (a dependency of the published plugin), resolved from the plugin's own location.
 * @returns the executable, or undefined when the package is not installed (a linked checkout).
 */
export function dependencyRuntime(): string | undefined {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  try {
    const manifest = createRequire(import.meta.url).resolve(`@oven/bun-${platform}-${process.arch}/package.json`)
    return join(dirname(manifest), 'bin', executable)
  } catch {
    return undefined
  }
}

/**
 * The executable that runs the server: the configured one, a runtime placed in
 * `apps/toonflow/runtime` (development builds), the Bun package installed with the
 * plugin, the host itself, else bun.
 */
async function resolveRuntime(configured: string | undefined, root: string): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
  if (configured !== undefined && configured.trim() !== '') return { command: configured.trim(), env: {} }
  const bundled = join(root, 'runtime', process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (await exists(bundled)) return { command: bundled, env: {} }
  const installed = dependencyRuntime()
  if (installed !== undefined && await exists(installed)) return { command: installed, env: {} }
  // The host's own executable runs Node code with this switch (Electron and Node both honour it).
  const host = process.execPath
  return { command: host, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * Film's private runtime: one ToonFlow server child process, one loopback bridge
 * to the account plugin, and one page session. Nothing here is exposed beyond
 * 127.0.0.1, and no credential ever reaches the page or the plugin's config.
 */
export class FilmRuntime {
  private opening?: Promise<string>
  private child?: ChildProcess
  private bridge?: Awaited<ReturnType<typeof startBridge>>
  private disposed = false
  /** Failed starts since the last success, and when the last one failed. */
  private failures = 0
  private lastFailureAt = 0
  /** This session's log of the server's own error output, for support. */
  private log?: WriteStream
  /** Set while this runtime holds the data directory's lock. */
  private lockPath?: string
  /** Identifies this runtime inside the lock file; a restart keeps the same one. */
  private readonly instanceId = randomBytes(8).toString('hex')

  constructor(
    private readonly services: () => { media?: MediaService; asker?: OneShotServices; skillRoots?: () => readonly string[]; workspaces?: () => readonly WorkspaceEntry[] },
    private readonly options: RuntimeOptions = {},
  ) {}

  /**
   * The URL a browser should open. The process is shared; the link is built for
   * this call only, so a second tab (another session, another workspace) never
   * receives the first caller's project.
   * @param query - page parameters for this caller (`filmWorkspace=<path>` opens
   *   that workspace's project; `filmMode=import` treats it as a folder to import).
   * @param lease - the tab this link is for; the process stays up while any
   *   lease is held and stops shortly after the last one is released.
   */
  open(query: Record<string, string> = {}, lease?: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Film Studio 已卸载或已关闭'))
    if (lease !== undefined) {
      this.leases.add(lease)
      this.cancelPendingStop()
    }
    return (this.opening ??= this.start().catch((error: unknown) => {
      this.opening = undefined
      throw error
    })).then(() => this.entryUrl(query))
  }

  /**
   * The tab behind this lease was closed. When no tab holds the workbench any
   * more the process is stopped — after a short grace period, so the page's
   * last saves (sent as it was closed) still reach it, and so a tab that is
   * reopened at once keeps the running process.
   * @param lease - the tab id given to {@link open}.
   */
  release(lease: string): void {
    this.leases.delete(lease)
    if (this.leases.size > 0 || this.child === undefined) return
    this.cancelPendingStop()
    this.pendingStop = setTimeout(() => {
      this.pendingStop = undefined
      if (this.leases.size === 0) void this.stop()
    }, STOP_GRACE_MS)
  }

  /** Tabs currently holding the workbench. */
  private readonly leases = new Set<string>()
  private pendingStop?: ReturnType<typeof setTimeout>
  private cancelPendingStop(): void {
    if (this.pendingStop !== undefined) clearTimeout(this.pendingStop)
    this.pendingStop = undefined
  }

  /** The loopback origin the server reported when it became ready. */
  private serverOrigin?: string
  /** The page token minted for this run; a fresh one every start. */
  private webToken?: string
  /** The agent-command token for this run (see {@link agentRequest}). */
  private controlToken?: string

  /** Whether the workbench process is up (an agent command can reach it). */
  get running(): boolean {
    return this.serverOrigin !== undefined && this.controlToken !== undefined
  }

  /**
   * Send one agent command to the running workbench (`/api/film/agent/…`), as the
   * host: the page cannot, because only this runtime holds the control token.
   * @param path - `tools` or `call`.
   * @param body - JSON body for `call`; omitted for `tools`.
   * @param signal - cancels the request (and with it the operation on the page).
   * @returns the route's `data`.
   */
  async agentRequest(path: 'tools' | 'call', body: unknown, signal: AbortSignal): Promise<unknown> {
    const origin = this.serverOrigin
    const token = this.webToken
    const control = this.controlToken
    if (origin === undefined || token === undefined || control === undefined) {
      throw new Error('影视工作台没有打开：先调用 film_studio_open 在侧栏打开它，再操作画布')
    }
    const response = await fetch(`${origin}/s/${token}/api/film/agent/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${control}`, 'content-type': 'application/json', 'x-toonflow-workspace': '1' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal,
    })
    const payload = await response.json().catch(() => undefined) as { code?: number; data?: unknown; message?: string } | undefined
    if (!response.ok || payload === undefined || (payload.code !== undefined && payload.code !== 200)) {
      throw new Error(payload?.message ?? `影视工作台返回 HTTP ${response.status}`)
    }
    return payload.data
  }

  /**
   * The page link. Page parameters travel in the query string, not in the hash:
   * the server's first response redirects `/` to `/`, and a fragment would not
   * survive that redirect. The app turns them into its own route after loading.
   */
  private entryUrl(extra: Record<string, string>): string {
    const origin = this.serverOrigin
    if (origin === undefined) throw new Error('Film 服务尚未就绪')
    const query = new URLSearchParams()
    if (this.webToken !== undefined) query.set('filmAccess', this.webToken)
    for (const [key, value] of Object.entries(extra)) if (value !== '') query.set(key, value)
    const suffix = query.size === 0 ? '' : `/?${query.toString()}`
    return `${origin}${suffix}`
  }

  private async start(): Promise<string> {
    const { media } = requireAccountServices(this.services())
    const { asker, skillRoots } = this.services()
    // A crash loop is not retried forever: after a few failures the next attempt waits,
    // then refuses for a cooldown with a message the user can act on.
    const sinceFailure = this.now() - this.lastFailureAt
    if (this.failures >= START_FAILURE_LIMIT && sinceFailure < START_COOLDOWN_MS) {
      const seconds = Math.ceil((START_COOLDOWN_MS - sinceFailure) / 1000)
      throw new Error(`Film 连续 ${this.failures} 次启动失败，已暂停重试；约 ${seconds} 秒后可再试。若持续失败，请检查插件数据目录与运行产物是否完整。`)
    }
    if (this.failures >= START_FAILURE_LIMIT) { this.failures = 0; this.lastFailureAt = 0 }
    const root = resolve(this.options.toonflowDirectory?.trim() || packagedApp() || '')
    const layout = layoutOf(root)
    for (const required of layout.required) {
      if (!await exists(required)) {
        throw new Error(`Film 运行产物不完整（缺少 ${required}）。开发时请先构建 ToonFlow 并设置 toonflowDirectory；安装版请重新安装插件。`)
      }
    }
    const delayMs = startDelayMs(this.failures)
    if (delayMs > 0) await new Promise(resume => setTimeout(resume, delayMs))
    const dataDirectory = resolve(this.options.dataDirectory?.trim() || join(homedir(), '.vibedev', 'film-studio', 'data'))
    await this.acquireLock(dataDirectory)
    const log = await this.openLog(dataDirectory)
    const webToken = randomBytes(32).toString('hex')
    // Held only here: the workbench accepts agent commands (/api/film/agent) with it, never from the page.
    const controlToken = randomBytes(32).toString('hex')
    const workspaces = this.services().workspaces
    const bridge = await startBridge({ ...asker === undefined ? {} : { asker }, ...skillRoots === undefined ? {} : { skillRoots }, ...workspaces === undefined ? {} : { workspaces }, media })
    if (this.disposed) { await bridge.close(); throw new Error('Film Studio 已关闭') }
    this.bridge = bridge
    const runtime = await resolveRuntime(this.options.runtimePath, root)
    const child = spawn(runtime.command, [...layout.args], {
      cwd: root,
      windowsHide: true,
      // stdin is a lifeline, not input: the server exits when it closes, which
      // happens however this host ends — a normal quit, a crash, or a forced kill —
      // so the workbench process never outlives it (FILM_PARENT_PIPE).
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...runtime.env,
        NODE_ENV: 'production',
        FILM_ACCOUNT_MODE: '1',
        FILM_APP_ROOT: root,
        FILM_BRIDGE_URL: bridge.url,
        FILM_BRIDGE_TOKEN: bridge.token,
        FILM_WEB_TOKEN: webToken,
        FILM_CONTROL_TOKEN: controlToken,
        FILM_PARENT_PIPE: '1',
        TOONFLOW_DATA_DIR: dataDirectory,
      },
    })
    this.child = child
    // Writes on a lifeline whose reader is gone must not throw in this process.
    child.stdin?.on('error', () => undefined)
    // stderr is drained without forwarding it: it may carry model request
    // diagnostics. The last few lines explain a failed start, and the same lines
    // go to this session's log file so a report can be diagnosed later.
    const tail: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim() === '') continue
        tail.push(line)
        log?.write(`${new Date().toISOString()} ${line}\n`)
      }
      if (tail.length > 5) tail.splice(0, tail.length - 5)
    })
    try {
      const url = await new Promise<string>((resolveReady, reject) => {
        const lines = createInterface({ input: child.stdout! })
        const timer = setTimeout(() => { done(); reject(new Error('Film 启动超时：请检查运行产物与运行时')) }, 60_000)
        const done = () => { clearTimeout(timer); lines.close() }
        child.once('error', (error) => { done(); reject(error) })
        child.once('exit', (code, signal) => {
          done()
          // An exit while tabs are open is what the page later sees as "Network Error"; record it.
          try { log?.write(`${new Date().toISOString()} exited code=${code ?? ''} signal=${signal ?? ''} leases=${this.leases.size}\n`) } catch { /* log closed */ }
          this.forget(child, bridge)
          // The server's own last words, redacted: a failed start should say why.
          const said = tail.map(redactLine).filter(line => line !== '').slice(-3).join(' / ')
          reject(new Error(`Film 服务已退出（${code}）${said === '' ? '' : `：${said}`}`))
        })
        lines.on('line', (line) => {
          try {
            const value = JSON.parse(line) as { filmReady?: unknown }
            if (typeof value.filmReady === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.filmReady)) {
              done()
              child.stdout?.resume()
              log?.write(`${new Date().toISOString()} ready ${value.filmReady}\n`)
              // 宿主打开用的入口链接（顶层导航时 Cookie 有效）；
              // 内嵌 iframe 用同一个令牌的路径形式 /s/<token>/，不依赖 Cookie。
              const link = `${value.filmReady}/?filmAccess=${webToken}`
              this.serverOrigin = value.filmReady
              this.webToken = webToken
              this.controlToken = controlToken
              resolveReady(link)
            }
          } catch { /* ordinary startup output is not the readiness line */ }
        })
      })
      this.failures = 0
      this.lastFailureAt = 0
      return url
    } catch (error) {
      this.failures += 1
      this.lastFailureAt = this.now()
      this.closeLog()
      await this.releaseLock()
      child.kill()
      await bridge.close()
      throw error
    }
  }

  /**
   * One workbench per data directory: two servers on the same project files would
   * write over each other (nodes, tools, the app's own config). A lock left by a
   * process that no longer runs is taken over; a live one is reported as such.
   * @param dataDirectory - the directory this runtime will serve.
   */
  private async acquireLock(dataDirectory: string): Promise<void> {
    const path = join(dataDirectory, 'session.lock')
    await mkdir(dataDirectory, { recursive: true })
    const held = await readFile(path, 'utf8').then(readLock, () => undefined)
    const mine = held !== undefined && held.pid === process.pid && held.instanceId === this.instanceId
    if (held !== undefined && !mine && await isAlive(held.pid)) {
      throw new Error(`该 Film 数据目录已被另一个窗口的工作台使用（进程 ${held.pid}${held.startedAt === '' ? '' : `，自 ${held.startedAt}`}）。请先关闭那个窗口里的影视工作台，或为本插件设置另一个数据目录。`)
    }
    await writeFile(path, JSON.stringify({ pid: process.pid, instanceId: this.instanceId, startedAt: new Date().toISOString() }), 'utf8')
    this.lockPath = path
  }

  /** Give up the data directory, if this runtime holds it. */
  private async releaseLock(): Promise<void> {
    const path = this.lockPath
    this.lockPath = undefined
    if (path === undefined) return
    // Only remove our own lock: another process may have taken it over meanwhile.
    const held = await readFile(path, 'utf8').then(readLock, () => undefined)
    if (held?.pid !== process.pid || held.instanceId !== this.instanceId) return
    await unlink(path).catch(() => undefined)
  }

  /**
   * This session's log: the server's own error output and the readiness line —
   * never the page's requests. Pruned to the newest few files, so support has
   * something to read without the directory growing forever. A log that cannot be
   * opened is not fatal: it is diagnostics, not a feature.
   */
  private async openLog(dataDirectory: string): Promise<WriteStream | undefined> {
    const directory = join(dataDirectory, 'logs')
    try {
      await mkdir(directory, { recursive: true })
      for (const name of staleLogs(await readdir(directory))) await unlink(join(directory, name)).catch(() => undefined)
      const stream = createWriteStream(join(directory, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), { flags: 'a' })
      stream.on('error', () => undefined)
      this.log = stream
      return stream
    } catch {
      return undefined
    }
  }

  private closeLog(): void {
    this.log?.end()
    this.log = undefined
  }

  /** The clock, kept swappable for tests. */
  private now(): number {
    return Date.now()
  }

  /**
   * Stop the server and the bridge, and let a later {@link open} start fresh.
   * This is what the host calls when the workbench tab is gone: the process
   * should not outlive the page, and reopening must work.
   */
  async stop(): Promise<void> {
    this.cancelPendingStop()
    await this.shutdown()
  }

  /** Stop for good: the plugin is being unloaded, so `open` refuses from now on. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelPendingStop()
    this.leases.clear()
    await this.shutdown()
  }

  /** The name the plugin's unload path used before; same as {@link dispose}. */
  close(): Promise<void> {
    return this.dispose()
  }

  /**
   * Stop the current attempt: kill the child if it still runs, close its bridge,
   * and drop both so the next `open` builds new ones.
   */
  private async shutdown(): Promise<void> {
    const child = this.child
    const bridge = this.bridge
    this.child = undefined
    this.bridge = undefined
    this.opening = undefined
    // A restarted server mints a new origin and token; never hand out the old pair.
    this.serverOrigin = undefined
    this.webToken = undefined
    this.controlToken = undefined
    this.closeLog()
    await this.releaseLock()
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((closed) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); closed() }, 3_000)
        child.once('close', () => { clearTimeout(timer); closed() })
        child.kill()
      })
    }
    await bridge?.close()
  }

  /** Drop this attempt's process and bridge, unless a newer attempt already replaced them. */
  private forget(child: ChildProcess, bridge: Awaited<ReturnType<typeof startBridge>>): void {
    if (this.child === child) this.child = undefined
    if (this.bridge === bridge) this.bridge = undefined
    this.opening = undefined
    this.serverOrigin = undefined
    this.webToken = undefined
    this.controlToken = undefined
    void bridge.close()
  }
}
