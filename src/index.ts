import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
// The Agent interface is completed by the runtime types: `session` (and with it the
// session's working directory) is declared there, not in the minimal base type.
import type {} from '@deepseek-ai/dsh-agent'
import { isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { WorkspaceEntry } from './bridge.js'
import { appRootOf, dataDirectoryOf, FilmRuntime, type RuntimeOptions } from './runtime.js'
import { registerFilmSkills, type SkillRegistryLike } from './skills.js'
import { TabOpens } from './tab-opens.js'
import type { MediaService } from './contracts.js'
import type { OneShotServices } from './oneshot.js'

export const name = 'dsh-film-studio'

/**
 * Nothing is required up front. The account plugin's Film interface (0.3.0) may
 * still be missing — a plugin that waits for it would never activate, so the
 * workbench tab would not even appear. Instead the entry activates, the tab
 * opens, and each use reports exactly what is missing (see `requireAccountServices`).
 * Only the agent tool waits for the account services: a tool that can never run
 * does not belong in the agent's list.
 */
export const inject = []

export const Config: Schema<RuntimeOptions> = Schema.object({  toonflowDirectory: Schema.string().default('').description('开发用：已构建的 ToonFlow 目录；留空使用插件自带的 apps/toonflow'),
  dataDirectory: Schema.string().default('').description('Film 数据目录，默认 ~/.vibedev/film-studio/data'),
  runtimePath: Schema.string().default('').description('运行 ToonFlow 服务的可执行文件；留空按 随包运行时 → 宿主自身 → bun 解析'),
})

/**
 * Film Studio: the ToonFlow workbench in the host's side panel.
 *
 * The workbench itself is a separate local process (its own data directory,
 * loopback only), reached through a session link the host hands out. Models and
 * media generation are relayed to this plugin's account services, so the page
 * never holds a credential.
 */
export function apply(ctx: Context, config: RuntimeOptions): void {
  /** Where the workbench keeps its skills: the data directory first (the user's edits win), then the packaged app. */
  const skillRoots = () => [join(dataDirectoryOf(config), 'skills'), join(appRootOf(config), 'build/skills')]
  const runtime = new FilmRuntime(() => {
    const asker = oneShotServices(ctx)
    return {
      media: ctx.get('vibedevMedia') as MediaService | undefined,
      ...asker === undefined ? {} : { asker },
      skillRoots,
      workspaces: () => listWorkspaces(ctx),
    }
  }, config)
  ctx.effect(() => () => runtime.close(), 'film-studio: stop the private runtime')

  // The workbench's skills join the session's skill catalog (`/vibedev-film`,
  // `/film-workflow`, `/film-canvas`, and any the user made in the workbench).
  ctx.inject(['skills'], (child) => {
    const skills = child.get('skills') as SkillRegistryLike | undefined
    if (skills === undefined) return
    child.effect(() => registerFilmSkills(skills, skillRoots, () => [skillRoots()[0]!]), 'film-studio: skills')
  })

  const opens = new TabOpens()
  ctx.effect(() => () => { opens.dispose() }, 'film-studio: tab opens')

  ctx.inject(['connection'], (child) => {
    // The browser half long-polls this for "open the workbench in session X",
    // which `film_studio_open` asks for from the host side. It is a GET: it only
    // waits to be told something, and the desktop app, before installing an
    // update, waits (10 s at most) for every admitted request that is not a read.
    // As a POST this 25 s poll made that wait miss its deadline.
    child.effect(() => {
      child.connection.fetch.register({
        path: '/api/dsh-film-studio/opens',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => Response.json({ opens: await opens.wait(25_000, request.signal) }, { headers: { 'cache-control': 'no-store' } }),
      })
      return () => {}
    }, 'film-studio: tab open feed')
    // The arrow bodies deliberately do not return the register() result as the
    // effect's disposer: `effect` takes a callback returning a disposer, and a
    // stray return value would be treated as one.
    child.effect(() => {
      child.connection.fetch.register({
        path: '/api/dsh-film-studio/open',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            // The tab sends its session's workspace (it knows it; this route does
            // not) and its own id as the lease that keeps the process up.
            const body = await readOpenBody(request)
            const query: Record<string, string> = body.workspace === undefined ? {} : { filmWorkspace: body.workspace }
            return Response.json({ url: await runtime.open(query, body.lease) }, { headers: { 'cache-control': 'no-store' } })
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'Film 启动失败' }, { status: 503 })
          }
        },
      })
      return () => {}
    }, 'film-studio: host launch route')
    // A workbench tab was closed. The process stops once no tab holds it, after
    // a grace period that lets the page's final saves land.
    child.effect(() => {
      child.connection.fetch.register({
        path: '/api/dsh-film-studio/close',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const { lease } = await readOpenBody(request)
          if (lease === undefined) await runtime.stop()
          else runtime.release(lease)
          return Response.json({ released: true }, { headers: { 'cache-control': 'no-store' } })
        },
      })
      return () => {}
    }, 'film-studio: host stop route')
  })

  // The tools appear once the account plugin can serve media — the one service the
  // workbench cannot start without. `vibedevGateway` (text models, account plugin
  // 0.3.0) is optional: requiring it hid all three tools from every session on
  // account plugin 0.2.x, although the workbench itself runs fine there.
  ctx.inject(['tools', 'vibedevMedia'], (child) => {
    child.tools.register(defineTool({
      name: 'film_studio_open',
      description: [
        '在当前对话的右侧栏打开「影视工作台」（VibeDev Film：小说拆解、剧本、分镜画布、图片/视频/音频生成、导演台、剪辑成片）。',
        '用户想做短剧、漫剧、动画、宣传片、MV、分镜、剧本或任何视频创作时，先调用它把工作台打开，再用 film_tools / film_call 按用户的需求操作画布。',
        '工作台直接进入本对话工作区的项目（工作区下的「VibeDev Film」文件夹，没有就新建，不会改动工作区里的其他文件）。',
        '已经打开时调用它只会把标签页切到前面，不会重开。返回时工作台已经就绪（ready=true），可以马上操作；',
        '用户切到别的标签页或别的对话时工作台仍在后台运行，你的操作照常有效；只有用户关掉（×）标签页后才需要再次调用。',
        '模型与媒体生成使用已登录的 VibeDev 账号。',
      ].join(''),
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          ready: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        } },
        render: (_args, result) => [{ type: 'text', text: result.message }],
      },
      async execute(_args: Record<string, never>, exec: { agent?: { session: { id: string } }; signal: AbortSignal }) {
        const sessionId = exec.agent?.session.id
        if (sessionId === undefined) throw new Error('film_studio_open 需要在对话里调用')
        const { delivered } = opens.request(sessionId)
        // Return once the page is connected, so the next call can operate the canvas.
        const ready = await waitForPage(runtime, exec.signal, 45_000)
        if (ready) return { ready: true, message: '影视工作台已在侧栏打开并就绪。下一步：调用 film_tools 查看可用操作，再用 film_call 操作画布。' }
        return {
          ready: false,
          message: delivered
            ? '已请求在侧栏打开影视工作台，但它还没有就绪：用户可能不在这个对话的界面上，切回来后会自动打开。稍后再调用 film_tools 确认。'
            : '已请求打开影视工作台，但当前没有打开着的 VibeDev 页面；用户打开这个对话时会自动打开。',
        }
      },
    }))

    child.tools.register(defineTool({
      name: 'film_tools',
      description: [
        '列出影视工作台当前能做的操作（读取应用与画布状态、打开项目、切换画布/文档面板、读写文档、工作区文件，',
        '以及画布节点工具：添加/连接节点、生成图片视频音频、剪辑成片、小说转文本等），附带使用说明。',
        '不带 name 时返回说明与全部操作的名字和简介；带 name 时返回那一个操作的完整参数 schema。工作台需要先用 film_studio_open 打开。',
      ].join(''),
      parameters: {
        name: { type: 'string', description: '要查看完整参数的操作名；留空列出全部' },
      },
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, result) => [{ type: 'text', text: result.text }],
      },
      async execute(args: { name?: string }, exec: { signal: AbortSignal }) {
        const data = await runtime.agentRequest('tools', undefined, exec.signal) as { guide: string; tools: { name: string; description: string; inputSchema: unknown }[] }
        if (args.name !== undefined && args.name.trim() !== '') {
          const tool = data.tools.find(item => item.name === args.name!.trim())
          if (tool === undefined) throw new Error(`没有名为 ${args.name} 的操作；可用：${data.tools.map(item => item.name).join(', ')}`)
          return { text: JSON.stringify(tool, null, 2) }
        }
        const list = data.tools.map(item => `- ${item.name}：${item.description.split('\n')[0]!.slice(0, 200)}`).join('\n')
        return { text: `${hostGuide}\n\n## 可用操作（film_call 的 name）\n${list}\n\n## 工作台自带的使用说明（原为外部 MCP 编写：其中的工具名即 film_call 的 name，参数放进 args，target 同样可用）\n${data.guide}` }
      },
    }))

    child.tools.register(defineTool({
      name: 'film_call',
      description: [
        '执行影视工作台的一个操作（名字与参数见 film_tools）。args 是该操作的参数；target 可选，用来指定页面（connectionId）、项目目录（directory）或画布（canvasId）。',
        '先用 getAppState 了解当前项目、画布与可用的节点工具，再操作。工作台在后台（用户切到别的标签页或对话）时同样可用。',
      ].join(''),
      parameters: {
        name: { type: 'string', required: true, description: '操作名，例如 getAppState、openProject、switchPanel，或 getAppState 返回的节点工具' },
        args: { type: 'object', additionalProperties: true, description: '该操作的参数（见 film_tools name=<操作名>）' },
        target: { type: 'object', additionalProperties: true, description: '可选：{ connectionId?, directory?, canvasId? }' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, result) => [{ type: 'text', text: result.text }],
      },
      async execute(args: { name: string; args?: Record<string, unknown>; target?: Record<string, unknown> }, exec: { signal: AbortSignal }) {
        const data = await runtime.agentRequest('call', {
          name: args.name,
          input: { args: args.args ?? {}, ...args.target === undefined ? {} : { target: args.target } },
        }, exec.signal) as { result: unknown }
        const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)
        return { text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n…（结果过长，已截断）` : text }
      },
    }))
  })
}

/** How the host-session agent should use the workbench; prepended to the workbench's own guide. */
const hostGuide = [
  '# 在影视工作台里帮用户做片',
  '- 工作台的画布是节点图：文本（剧本/分镜描述）、图片、视频、音频节点，以及生成节点（图片生成、视频生成、音频生成）、导演台、剪辑台等；节点之间连线表示把上游的输出作为下游的输入。',
  '- 做片的完整方法（从创意/小说/剧本到资产、视频片段、成片）在技能 film-workflow，画布操作手册在技能 film-canvas：开始制作前先读。',
  '- 先 film_call getAppState：看 connections 里当前打开的项目（directory）、画布（canvasId）和 tools（当前画布上节点暴露的工具，名字形如 node:xxx）。',
  '- 节点工具（node:xxx）通过 film_call 调用，name 用节点工具名，target 带上 getAppState 给的 connectionId；画布与节点的具体参数用 film_tools name=<名字> 查看。',
  '- 生成会使用用户已登录的 VibeDev 账号并产生费用：按用户的要求生成，不要做无关的试验性生成。',
  '- 用户切到别的标签页或别的对话时工作台仍在后台运行，可以继续操作；用户关掉工作台标签页后，先调用 film_studio_open 再继续。',
].join('\n')

/**
 * The host services "帮写" and the other fixed writing jobs use: VibeDev Next's
 * model channel, the conversation's model selection, and image attachments.
 * Undefined when the host has no model service.
 */
function oneShotServices(ctx: Context): OneShotServices | undefined {
  const llm = ctx.get('llm') as OneShotServices['llm'] | undefined
  if (llm === undefined) return undefined
  const sessionController = ctx.get('sessionController') as OneShotServices['sessionController'] | undefined
  const agentDefaultModel = ctx.get('agentDefaultModel') as OneShotServices['agentDefaultModel'] | undefined
  const attachments = ctx.get('attachments') as OneShotServices['attachments'] | undefined
  return {
    llm,
    ...sessionController === undefined ? {} : { sessionController },
    ...agentDefaultModel === undefined ? {} : { agentDefaultModel },
    ...attachments === undefined ? {} : { attachments },
  }
}
/** Wait until the workbench page is connected (its control channel is up), or give up. */
async function waitForPage(runtime: FilmRuntime, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !signal.aborted) {
    if (runtime.running) {
      try {
        const state = await runtime.agentRequest('call', { name: 'getAppState', input: { args: {} } }, signal) as { result?: { connections?: unknown[] } }
        if ((state.result?.connections?.length ?? 0) > 0) return true
      } catch {
        // Not up yet; try again.
      }
    }
    await new Promise(resume => setTimeout(resume, 500))
  }
  return false
}

/**
 * What the tab sent: its session's workspace (the tab knows it from the host's
 * session list; this route does not) and its own id as the lease that keeps the
 * process up. Both are optional; anything unusable is ignored.
 */
async function readOpenBody(request: Request): Promise<{ workspace?: string; lease?: string }> {
  try {
    const body = await request.json() as { workspace?: unknown; lease?: unknown }
    const workspace = typeof body.workspace === 'string' && isAbsolute(body.workspace.trim()) ? body.workspace.trim() : undefined
    const lease = typeof body.lease === 'string' && /^[\w:.-]{1,200}$/.test(body.lease) ? body.lease : undefined
    return { ...workspace === undefined ? {} : { workspace }, ...lease === undefined ? {} : { lease } }
  } catch {
    return {}
  }
}

/**
 * Every VibeDev workspace this host knows, for the project center. Read at call
 * time so a workspace added later is seen; an older host without the registry
 * simply contributes none.
 */
function listWorkspaces(ctx: Context): readonly WorkspaceEntry[] {
  try {
    const registry = ctx.get('workspaceRegistry') as { list?: () => readonly { id: string; title: string; path: string }[] } | undefined
    return (registry?.list?.() ?? []).map(({ id, title, path }) => ({ id: String(id), title, path }))
  } catch {
    return []
  }
}
