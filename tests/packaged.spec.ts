import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { FilmRuntime, STOP_GRACE_MS, dependencyRuntime } from '../src/runtime.js'
import { bunRuntimeFor } from '../scripts/bun-runtime.mjs'
import type { MediaService } from '../src/contracts.js'
import type { OneShotServices } from '../src/oneshot.js'

/**
 * The packaged app, started exactly as the host starts it: the bundled runtime,
 * an isolated data directory, a dead bridge (the account plugin is not needed to
 * boot), and the page session link the host hands out.
 *
 * Skipped until `apps/toonflow` has been built into this checkout.
 */
const packaged = resolve(import.meta.dirname, '../apps/toonflow')
const available = existsSync(join(packaged, 'build/server/film.js'))

// The bridge is only called for a model or media request; booting must not need it.
// Text jobs go to "the conversation's model": here a fake that records what it was asked.
const asked: Record<string, unknown>[] = []
const sessions: string[] = []
const asker: OneShotServices = {
  llm: { async *stream(options) { asked.push(options); yield { type: 'text-delta', index: 0, text: '这是对话模型的回答' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
  sessionController: { projections: async ({ sessionId }) => { sessions.push(sessionId); return null } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-chat' }) },
}
const media = { models: async () => [], generateImages: async () => { throw new Error('bridge not started') }, startVideo: async () => { throw new Error('bridge not started') }, task: async () => undefined } as unknown as MediaService

describe.skipIf(!available)('the packaged Film app', () => {
  it('boots from the plugin own directory, protects the page and reports the account-managed settings', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-packaged-'))
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    try {
      const url = await runtime.open()
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?filmAccess=[a-f0-9]{64}$/)
      const origin = new URL(url).origin

      // No session, no page: the local service is not open to other programs.
      expect((await fetch(`${origin}/api/settings/get`)).status).toBe(401)

      // 内嵌 iframe 的通道：同一枚令牌放在路径里，不需要 Cookie 也能取到接口
      // （跨源内嵌时浏览器可能不保留会话 Cookie，这正是之前那句"请从 DSH 打开"的成因）。
      const pathToken = new URL(url).searchParams.get('filmAccess')!
      const viaPath = await fetch(`${origin}/s/${pathToken}/api/settings/get`, { headers: { 'x-toonflow-workspace': '1', origin, referer: `${origin}/` } })
      expect(viaPath.status, `路径会话返回 ${viaPath.status}`).toBe(200)
      expect((await viaPath.json() as { data: { filmAccountManaged?: boolean } }).data.filmAccountManaged).toBe(true)

      // The link the host opens exchanges its one-time token for the page cookie.
      const bootstrap = await fetch(url, { redirect: 'manual' })
      expect(bootstrap.status).toBe(303)
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!

      // The page's own requests carry the workspace marker the app's routes expect.
      const headers = { cookie, origin, referer: `${origin}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }

      // Account-managed settings arrive even while the bridge is down, with the reason.
      const settingsResponse = await fetch(`${origin}/api/settings/get`, { headers })
      expect(settingsResponse.status).toBe(200)
      const settings = await settingsResponse.json() as { data: Record<string, unknown> }
      expect(settings.data.filmAccountManaged).toBe(true)
      expect(typeof settings.data.filmAccountMessage).toBe('string')

      // Provider configuration belongs to the account plugin in this mode.
      expect((await fetch(`${origin}/api/providers/models`, { method: 'POST', headers, body: '{}' })).status).toBe(403)

      // The same URL stays stable: reopening does not start a second service.
      expect(await runtime.open()).toBe(url)

      // Closing the tab stops the process, and opening again starts a fresh one
      // (the old port is gone, so the link is a new one).
      const closed = new URL(url)
      await runtime.stop()
      await expect(fetch(`${closed.origin}/api/settings/get`, { headers })).rejects.toThrow()
      const reopened = await runtime.open()
      expect(new URL(reopened).port).not.toBe(closed.port)

      // Unloading the plugin is final: nothing starts after it.
      await runtime.dispose()
      await expect(runtime.open()).rejects.toThrow(/已卸载|已关闭/)
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('opens the session workspace project in its own VibeDev Film folder, and never touches what is not ours', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-project-'))
    const root = await realpath(await mkdtemp(join(tmpdir(), 'film-workspaces-')))
    const registered: { id: string; title: string; path: string }[] = []
    const runtime = new FilmRuntime(() => ({ media, asker, workspaces: () => registered }), { dataDirectory })
    type Prepared = { workspace: string; directory: string; outcome: string; canvasName: string | null; notices: string[] }
    const canvas = { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
    try {
      const workspace = join(root, '我的仓库')
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'package.json'), '{"name":"demo"}\n')
      registered.push({ id: 'w1', title: '我的仓库', path: workspace })

      // Each caller gets its own link: another tab's workspace never leaks into it.
      const url = await runtime.open({ filmWorkspace: workspace })
      expect(new URL(url).searchParams.get('filmWorkspace')).toBe(workspace)
      expect(new URL(await runtime.open()).searchParams.has('filmWorkspace')).toBe(false)
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`${origin}/s/${token}${path}`, {
          method: 'POST', headers: { origin, referer: `${origin}/s/${token}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        expect(response.status, `${path} 返回 ${response.status}`).toBe(200)
        return (await response.json() as { data: unknown }).data
      }
      const prepare = (body: Record<string, unknown>) => call('/api/workspaces/film/prepare', body) as Promise<Prepared>

      // 1. 不存在 → 在工作区下建 VibeDev Film，放标记与第一张画布；工作区根目录只多这一个文件夹。
      const first = await prepare({ workspace })
      expect(first.outcome).toBe('created')
      expect(first.directory).toBe(join(workspace, 'VibeDev Film'))
      expect(first.canvasName).toBe('画布1.json')
      expect(JSON.parse(await readFile(join(first.directory, '画布1.json'), 'utf8'))).toEqual(canvas)
      expect((await readdir(workspace)).sort()).toEqual(['VibeDev Film', 'package.json', 'src'].sort())
      expect(await readFile(join(workspace, 'package.json'), 'utf8')).toBe('{"name":"demo"}\n')

      // 2. 再开一次 → 复用，什么都不改。
      const again = await prepare({ workspace, preferred: first.directory })
      expect(again.outcome).toBe('reused')
      expect(again.notices).toEqual([])
      expect((await readdir(first.directory)).sort()).toEqual(['.vibedev-film.json', '画布1.json'].sort())

      // 3. 同名但不是我们的文件夹 → 一个字都不动，改用 VibeDev Film (2)，提示一行。
      const other = join(root, '别人的仓库')
      await mkdir(join(other, 'VibeDev Film'), { recursive: true })
      await writeFile(join(other, 'VibeDev Film', '画布1.json'), '{"not":"a canvas"}\n')
      const foreign = await prepare({ workspace: other })
      expect(foreign.directory).toBe(join(other, 'VibeDev Film (2)'))
      expect(foreign.notices.length).toBe(1)
      expect(await readdir(join(other, 'VibeDev Film'))).toEqual(['画布1.json'])
      expect(await readFile(join(other, 'VibeDev Film', '画布1.json'), 'utf8')).toBe('{"not":"a canvas"}\n')

      // 4. 同名的是一个文件 → 同样换名，不报错。
      const fileClash = join(root, '同名文件')
      await mkdir(fileClash, { recursive: true })
      await writeFile(join(fileClash, 'VibeDev Film'), 'mine\n')
      expect((await prepare({ workspace: fileClash })).directory).toBe(join(fileClash, 'VibeDev Film (2)'))

      // 5. 空文件夹 → 接管。
      const empty = join(root, '空的')
      await mkdir(join(empty, 'VibeDev Film'), { recursive: true })
      expect((await prepare({ workspace: empty })).outcome).toBe('adopted')

      // 6. 老项目：画布直接在工作区根目录 → 根目录就是项目，不再建子文件夹。
      const legacy = join(root, '老项目')
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, '分镜.json'), `${JSON.stringify(canvas)}\n`)
      const old = await prepare({ workspace: legacy })
      expect(old.outcome).toBe('legacy')
      expect(old.directory).toBe(legacy)
      expect(old.canvasName).toBe('分镜.json')
      expect(await readdir(legacy)).toEqual(['分镜.json'])

      // 7. 新建项目只问名字，直接建在工作区里；非法名字被拒绝。
      const named = await prepare({ workspace, name: '第二季' })
      expect(named.directory).toBe(join(workspace, '第二季'))
      const bad = await fetch(`${origin}/s/${token}/api/workspaces/film/prepare`, {
        method: 'POST', headers: { origin, referer: `${origin}/s/${token}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }, body: JSON.stringify({ workspace, name: 'a/b' }),
      })
      expect(bad.status).toBe(400)

      // 项目中心：全部登记的工作区里找，加上手动导入的；别人的同名文件夹不算项目。
      const imported = join(root, '外部项目')
      await mkdir(imported, { recursive: true })
      await writeFile(join(imported, '片头.json'), `${JSON.stringify(canvas)}\n`)
      registered.push({ id: 'w2', title: '别人的仓库', path: other })
      const center = await call('/api/workspaces/film/projects', { imported: [imported] }) as { projects: { directory: string; source: string }[]; workspaces: unknown[] }
      const listed = center.projects.map(project => project.directory)
      expect(listed).toEqual(expect.arrayContaining([first.directory, join(other, 'VibeDev Film (2)'), imported]))
      expect(listed).not.toContain(join(other, 'VibeDev Film'))
      expect(listed).not.toContain(join(workspace, '第二季'))
      expect(center.workspaces).toHaveLength(2)
      expect(center.projects.find(project => project.directory === imported)?.source).toBe('imported')
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('adds gallery media to the project, and lets the host agent drive the open page', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-agent-'))
    const root = await mkdtemp(join(tmpdir(), 'film-agent-ws-'))
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    const lifetime = new AbortController()
    try {
      const url = await runtime.open({ filmWorkspace: root })
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      const page = { origin, referer: `${origin}/s/${token}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${origin}/s/${token}${path}`, { method: 'POST', headers: page, body: JSON.stringify(body) })
        expect(response.status, `${path} 返回 ${response.status}`).toBe(200)
        return (await response.json() as { data: unknown }).data
      }
      const project = (await post('/api/workspaces/film/prepare', { workspace: root }) as { directory: string }).directory

      // 媒体画廊"加入画布"：外部文件复制进 assets/<节点id>/；项目里的文件直接引用；网页拒收。
      const outside = join(root, 'media')
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64'))
      await writeFile(join(outside, 'page.html'), '<p>x</p>')
      await writeFile(join(project, 'inside.mp3'), 'ID3')
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
      const imported = await post('/api/workspaces/film/importMedia', { directory: project, items: [
        { source: join(outside, 'shot.png'), nodeId: ids[0] },
        { source: join(project, 'inside.mp3'), nodeId: ids[1] },
        { source: join(outside, 'page.html'), nodeId: ids[2] },
      ] }) as { imported: { nodeId: string; path: string; kind: string }[]; failed: { source: string }[] }
      expect(imported.imported.map(item => [item.kind, item.path.startsWith(`assets/${item.nodeId}/`)])).toEqual([['image', true], ['audio', false]])
      expect(imported.imported[1]!.path).toBe('inside.mp3')
      expect(imported.failed.map(item => item.source)).toEqual([join(outside, 'page.html')])
      expect(await readFile(join(project, imported.imported[0]!.path))).toEqual(await readFile(join(outside, 'shot.png')))

      // 宿主 agent 的入口只认宿主手里的控制令牌：页面会话拿不到。
      expect((await fetch(`${origin}/s/${token}/api/film/agent/tools`, { headers: page })).status).toBe(403)
      const listed = await runtime.agentRequest('tools', undefined, lifetime.signal) as { guide: string; tools: { name: string }[] }
      const names = listed.tools.map(tool => tool.name)
      expect(names).toEqual(expect.arrayContaining(['getAppState', 'openProject', 'switchPanel', 'workspaceFiles']))
      expect(names).toEqual(expect.arrayContaining(['addNode', 'connectNodes', 'nodeTools', 'generateVideo', 'videoComposer', 'convertNovelToTxt']))
      for (const hidden of ['runAgent', 'read', 'write', 'edit', 'ls', 'web_fetch', 'web_search', 'browser']) expect(names).not.toContain(hidden)
      expect(listed.guide.length).toBeGreaterThan(500)

      // 页面在影视模式下凭会话连上控制通道（不需要 MCP 令牌）；agent 的命令经它执行并拿回结果。
      const connectionId = '44444444-4444-4444-8444-444444444444'
      const events = await fetch(`${origin}/s/${token}/api/mcp/control/events?connectionId=${connectionId}`, { headers: page, signal: lifetime.signal })
      expect(events.status).toBe(200)
      await post('/api/mcp/control/state', { connectionId, revision: 1, state: { directory: project, canvasId: '画布1.json', panel: 'workspace', projectList: [], tools: [] } })
      const state = await runtime.agentRequest('call', { name: 'getAppState', input: { args: {} } }, lifetime.signal) as { result: { connections: { id: string; state: { directory: string } }[] } }
      expect(state.result.connections.map(item => item.state.directory)).toEqual([project])
      const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
      const answered = (async () => {
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error('control stream ended')
          buffer += value
          const call = /data: (\{"type":"call".*\})\n/.exec(buffer)
          if (call === null) continue
          const request = JSON.parse(call[1]!) as { callId: string; name: string; args: unknown }
          expect(request.name).toBe('switchPanel')
          await post('/api/mcp/control/result', { connectionId, callId: request.callId, result: { panel: 'document' } })
          return
        }
      })()
      const switched = await runtime.agentRequest('call', { name: 'switchPanel', input: { args: { panel: 'document' } } }, lifetime.signal) as { result: unknown }
      await answered
      expect(switched.result).toEqual({ panel: 'document' })
    } finally {
      lifetime.abort()
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('waits out a video task through transient read failures, and explains a gateway failure', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-video-'))
    const root = await mkdtemp(join(tmpdir(), 'film-video-ws-'))
    let reads = 0
    let outcome: 'completed' | 'failed' = 'completed'
    let output = ''
    const videoMedia = {
      ...media,
      startVideo: async (_request: unknown, target: { folder: string; stem: string }) => {
        output = join(target.folder, `${target.stem}.mp4`)
        return { id: 'video-1', status: 'running' }
      },
      // The account plugin's task record: unreadable twice (busy, restarting), then settled.
      task: async () => {
        reads += 1
        if (reads <= 2) throw new Error('store busy')
        if (outcome === 'failed') return { id: 'video-1', status: 'failed', error: { code: 'video_controls_unavailable', message: '网页视频流程未完成（controls）：TypeError' } }
        await writeFile(output, 'video')
        return { id: 'video-1', status: 'completed', outputs: [{ path: output }] }
      },
    } as unknown as MediaService
    const runtime = new FilmRuntime(() => ({ media: videoMedia, asker }), { dataDirectory })
    try {
      const url = await runtime.open({ filmWorkspace: root })
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      const page = { origin, referer: `${origin}/s/${token}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }
      const prepared = await (await fetch(`${origin}/s/${token}/api/workspaces/film/prepare`, { method: 'POST', headers: page, body: JSON.stringify({ workspace: root }) })).json() as { data: { directory: string } }
      const generate = async () => JSON.parse((await (await fetch(`${origin}/s/${token}/api/ai/media/generate`, { method: 'POST', headers: page, body: JSON.stringify({
        directory: prepared.data.directory, mediaType: 'video', providerId: 'vibedev', modelId: 'seedance-2.5', prompt: '跳舞', outputDirectory: 'assets/node-1',
      }) })).text()).trim()) as { code: number; data?: { path: string }[]; message?: string }
      const done = await generate()
      expect(done.code, JSON.stringify(done)).toBe(200)
      expect(done.data?.[0]?.path).toMatch(/^assets\/node-1\/.+\.mp4$/)
      reads = 0
      outcome = 'failed'
      const failed = await generate()
      expect(failed.code).not.toBe(200)
      expect(failed.message).toContain('上游生成流程中断')
      expect(failed.message).toContain('video_controls_unavailable')
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
  it('prices a video by Tokens with reference lengths read from the files, carries the settlement, and opens .m4a in its own viewer', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'film-token-'))
    const dataDirectory = join(scratch, 'data')
    const root = join(scratch, 'workspace')
    await mkdir(root, { recursive: true })
    // A data directory seeded by an older build: its media viewer is 0.1.0 and plays no .m4a.
    await mkdir(join(dataDirectory, 'ext'), { recursive: true })
    await writeFile(join(dataDirectory, 'ext', 'ext-media.umd.js'), `/*! toonflowExt:${JSON.stringify({ id: 'ext-media', displayName: '音视频', extensions: ['mp4', 'mp3', 'wav', 'pcm', 'opus'], resourceKind: 'file', version: '0.1.0', readme: '', configRules: [] })} */\nvoid 0\n`)
    const videoPricing = { schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds', estimateOnly: true, rules: [
      { resolution: '480p', referenceVideo: false, pricePerMillionTokensCny: 60.06, estimatedPricePerSecondCny: 0.5819 },
      { resolution: '480p', referenceVideo: true, pricePerMillionTokensCny: 36.036, estimatedPricePerSecondCny: 0.6952 },
    ] }
    const quote = { status: 'estimate', mode: 'video_token', model: 'video-sd-2.5(TC)', currency: 'CNY', amountCny: '8.3424', estimatedPricePerSecondCny: 0.6952, pricePerMillionTokensCny: 36.036,
      outputSeconds: 7, referenceVideoSeconds: 5, billedSeconds: 12, rule: { resolution: '480p', referenceVideo: true }, estimateOnly: true, finalBasis: 'provider_tokens',
      label: { zh: '预计 ¥8.34 · 最终按实际视频 Token 结算', en: '' }, basis: { zh: '¥0.6952/秒 × (7 秒输出 + 5 秒参考视频)，¥36.036/百万 Token', en: '' } }
    const quoted: unknown[] = []
    let output = ''
    const tokenMedia: Record<string, unknown> = {
      ...media,
      models: async () => [{ id: 'video-sd-2.5(TC)', name: 'SD 2.5', kind: 'video', inputModalities: ['text', 'video'], video: { textToVideo: true, maxReferenceVideos: 1, durations: [4, 15], resolutions: ['480p'] }, videoPricing }],
      videoQuote: async (request: unknown) => { quoted.push(request); return quote },
      startVideo: async (_request: unknown, target: { folder: string; stem: string }) => {
        output = join(target.folder, `${target.stem}.mp4`)
        await writeFile(output, 'video')
        return { id: 'video-9', status: 'completed', outputs: [{ path: output }], settlement: 'pending', settlementPendingReason: 'usage_counters_inconsistent', estimatedCny: '3.98' }
      },
      task: async () => ({ id: 'video-9', status: 'completed', outputs: [{ path: output }], settlement: 'settled', chargedCny: '3.98066354', estimatedCny: '3.98', billing: { tokens: 100858 } }),
    }
    const runtime = new FilmRuntime(() => ({ media: tokenMedia as unknown as MediaService, asker }), { dataDirectory })
    try {
      const url = await runtime.open({ filmWorkspace: root })
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      const page = { origin, referer: `${origin}/s/${token}/`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(`${origin}/s/${token}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: page, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, ...JSON.parse((await response.text()).trim()) as { code: number; data?: any; message?: string } }
      }
      const directory = (await api('workspaces/film/prepare', { workspace: root })).data.directory as string
      // The model keeps its Token price on its way to the node.
      expect((await api('ai/media/models')).data).toEqual([expect.objectContaining({ providerId: 'vibedev', modelId: 'video-sd-2.5(TC)', videoPricing })])
      // A 5 s reference video in the project: its length comes from its own movie header.
      const box = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, 'latin1'); return Buffer.concat([head, body]) }
      const mvhd = Buffer.alloc(100)
      mvhd.writeUInt32BE(1000, 12)
      mvhd.writeUInt32BE(5000, 16)
      await mkdir(join(directory, 'assets', 'ref'), { recursive: true })
      await writeFile(join(directory, 'assets', 'ref', 'clip.mp4'), Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('mdat', Buffer.alloc(64)), box('moov', box('mvhd', mvhd))]))
      const body = { directory, providerId: 'vibedev', modelId: 'video-sd-2.5(TC)', resolution: '480p', duration: 7, videos: [{ path: 'assets/ref/clip.mp4' }], images: 1, audios: 0 }
      const answer = await api('film/videoQuote', body)
      expect(answer.code, JSON.stringify(answer)).toBe(200)
      expect(answer.data).toMatchObject({ status: 'estimate', mode: 'video_token', amountCny: '8.3424' })
      expect(quoted).toEqual([{ model: 'video-sd-2.5(TC)', resolution: '480p', durationSeconds: 7, references: { videos: [{ durationSeconds: 5 }], images: 1, audios: 0 } }])
      expect((await api('film/videoQuote', { ...body, videos: [{ path: '../outside.mp4' }] })).code).not.toBe(200)
      // An account plugin without videoQuote: said so, not an error.
      delete tokenMedia.videoQuote
      expect((await api('film/videoQuote', { ...body, videos: [] })).data).toEqual({ status: 'unsupported' })
      // The finished video: playable at once, its charge still being confirmed travels with it.
      const done = await api('ai/media/generate', { directory, mediaType: 'video', providerId: 'vibedev', modelId: 'video-sd-2.5(TC)', prompt: '跳舞', outputDirectory: 'assets/node-1' })
      expect(done.code, JSON.stringify(done)).toBe(200)
      expect(done.data[0]).toMatchObject({ path: expect.stringMatching(/^assets\/node-1\/.+\.mp4$/), mediaType: 'video', taskId: 'video-9', settlement: 'pending', settlementPendingReason: 'usage_counters_inconsistent', estimatedCny: '3.98' })
      expect(done.data[0]).not.toHaveProperty('chargedCny')
      // Later: only the original task is asked.
      expect((await api('film/settlement?id=video-9')).data).toEqual({ taskId: 'video-9', settlement: 'settled', chargedCny: '3.98066354', estimatedCny: '3.98', billing: { tokens: 100858 } })
      // The media viewer of this build replaced the older one, and plays what Film writes.
      const viewer = ((await api('ext/list')).data as { id: string; version: string; extensions: string[] }[]).find(item => item.id === 'ext-media')
      expect(viewer?.version).toBe('0.2.0')
      expect(viewer?.extensions).toEqual(expect.arrayContaining(['m4a', 'aac', 'webm', 'mov', 'm4v', 'ogg', 'flac', 'mp4', 'mp3', 'wav']))
    } finally {
      await runtime.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)
  it('answers every text request with the conversation model, and refuses agent loops', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-text-'))
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    try {
      const url = await runtime.open()
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      // The page's requests carry the link (with the conversation) as their Referer.
      const headers = { origin, referer: `${origin}/s/${token}/?filmSession=session-7`, 'x-toonflow-workspace': '1', 'content-type': 'application/json' }
      // One text model, "follow the conversation": node code (third-party too) picks it.
      const models = await (await fetch(`${origin}/s/${token}/api/ai/models`, { headers })).json() as { data: { modelId: string; label: string }[] }
      expect(models.data).toEqual([expect.objectContaining({ modelId: 'conversation', label: '跟随 VibeDev 对话' })])
      const context = { systemPrompt: '你是剪辑决策助手', messages: [{ role: 'user', content: '把片段按顺序排好', timestamp: 1 }] }
      const answer = await (await fetch(`${origin}/s/${token}/api/ai/generate`, { method: 'POST', headers, body: JSON.stringify({ providerId: 'vibedev', modelId: 'conversation', context }) })).text()
      expect(answer).toContain('"type":"done"')
      expect(answer).toContain('这是对话模型的回答')
      expect(asked.at(-1)).toMatchObject({ system: '你是剪辑决策助手', provider: 'deepseek-account', model: 'deepseek-chat' })
      // A tool loop is an agent's work: it is the conversation's job now.
      const loop = await (await fetch(`${origin}/s/${token}/api/ai/generate`, { method: 'POST', headers, body: JSON.stringify({ providerId: 'vibedev', modelId: 'conversation', context: { ...context, tools: [{ name: 'editDocument', description: 'x', parameters: { type: 'object' } }] } }) })).text()
      expect(loop).toContain('"type":"error"')
      expect(loop).toContain('VibeDev 对话')
      // 帮写 is mounted and reaches the conversation model with the brief.
      const written = await fetch(`${origin}/s/${token}/api/film/writePrompt`, { method: 'POST', headers, body: JSON.stringify({ kind: 'video', node: '视频生成', current: '雨夜' }) })
      expect(written.status).toBe(200)
      expect((await written.json() as { data: { prompt: string } }).data.prompt).toBe('这是对话模型的回答')
      expect(JSON.stringify(asked.at(-1))).toContain('雨夜')
      // Both asked for the model of the conversation named in the page link.
      expect(sessions).toEqual(['session-7', 'session-7'])
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 120_000)
  it('loads node, extension and tool scripts the page asks for by absolute path', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-assets-'))
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    try {
      const url = await runtime.open()
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      // `/api/nodes/files?…` is what the node list hands the page: no `/s/<token>/` prefix.
      const nodes = `${origin}/api/nodes/files?name=textNode`
      // From the session page (same-origin referer carries the token): loaded — this is "添加节点 is empty".
      expect((await fetch(nodes, { headers: { referer: `${origin}/s/${token}/` } })).status).toBe(200)
      // Without it, or with another token, still refused.
      expect((await fetch(nodes)).status).toBe(401)
      expect((await fetch(nodes, { headers: { referer: `${origin}/s/${'0'.repeat(64)}/` } })).status).toBe(401)
      expect((await fetch(nodes, { headers: { referer: `http://evil.example/s/${token}/` } })).status).toBe(401)
      // The session page tells the browser to keep the token out of referers to other sites.
      const page = await fetch(`${origin}/s/${token}/`)
      expect(page.headers.get('referrer-policy')).toBe('same-origin')
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps the process while any tab holds it, and stops it after the last one let go', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-lease-'))
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    const alive = async (origin: string) => fetch(`${origin}/api/settings/get`).then(() => true, () => false)
    try {
      const { origin } = new URL(await runtime.open({}, 'tab-a'))
      await runtime.open({}, 'tab-b')
      runtime.release('tab-a')
      await new Promise(resume => setTimeout(resume, STOP_GRACE_MS + 800))
      expect(await alive(origin)).toBe(true)
      runtime.release('tab-b')
      // Reopened within the grace period: the same process carries on.
      await new Promise(resume => setTimeout(resume, 300))
      expect(new URL(await runtime.open({}, 'tab-c')).origin).toBe(origin)
      runtime.release('tab-c')
      await new Promise(resume => setTimeout(resume, STOP_GRACE_MS + 1500))
      expect(await alive(origin)).toBe(false)
    } finally {
      await runtime.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('exits on its own when the host that started it is gone', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-lifeline-'))
    // The runtime the plugin starts: a copy placed in apps/toonflow/runtime, else the installed Bun package.
    const placed = join(packaged, 'runtime', bunRuntimeFor(process.platform, process.arch).executable)
    const runtimeExe = existsSync(placed) ? placed : dependencyRuntime()
    expect(runtimeExe, 'the platform Bun dependency must be installed').toBeDefined()
    if (runtimeExe === undefined) throw new Error('missing Bun runtime')
    const child = spawn(runtimeExe, [join(packaged, 'build/server/film.js')], {
      cwd: packaged, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NODE_ENV: 'production', FILM_ACCOUNT_MODE: '1', FILM_APP_ROOT: packaged, FILM_BRIDGE_URL: 'http://127.0.0.1:9', FILM_BRIDGE_TOKEN: 'b'.repeat(64), FILM_WEB_TOKEN: 'c'.repeat(64), FILM_PARENT_PIPE: '1', TOONFLOW_DATA_DIR: dataDirectory },
    })
    try {
      await new Promise<void>((ready, failed) => {
        const timer = setTimeout(() => { failed(new Error('not ready')) }, 30_000)
        child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('filmReady')) { clearTimeout(timer); ready() } })
      })
      const exited = new Promise<number | null>(done => { child.once('exit', code => { done(code) }) })
      // What a crashed or killed host leaves behind: the pipe closes.
      child.stdin?.end()
      const code = await Promise.race([exited, new Promise<'still running'>(resume => setTimeout(() => { resume('still running') }, 8_000))])
      expect(code).toBe(0)
    } finally {
      child.kill()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 60_000)

  it('re-seeds the built-in nodes, tools and skills into a data directory that was initialized before', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'film-reseed-'))
    // 与真实默认值同形：路径里有 .vibedev。点开头的目录曾让节点脚本全部 404（"请先安装并启用对应的基础节点"）。
    const dataDirectory = join(scratch, '.vibedev', 'film-studio', 'data')
    // 用户机器上的真实状态：数据目录早就初始化过（空标记文件），里面的内置节点是旧构建。
    await mkdir(join(dataDirectory, 'nodes'), { recursive: true })
    await mkdir(join(dataDirectory, 'tools'), { recursive: true })
    await mkdir(join(dataDirectory, 'skills', 'canvas'), { recursive: true })
    await writeFile(join(dataDirectory, 'nodes', 'initialized'), '')
    await writeFile(join(dataDirectory, 'tools', 'initialized'), '')
    await writeFile(join(dataDirectory, 'skills', 'initialized'), '')
    await writeFile(join(dataDirectory, 'nodes', 'videoNode.umd.js'), '// 旧构建\n')
    await writeFile(join(dataDirectory, 'tools', 'mine.tool.js'), '// 用户自己装的工具\n')
    // 退役工具：内置的那份（作者 Toonflow）要清掉；用户自己装的同名工具（别的作者）保留。
    await writeFile(join(dataDirectory, 'tools', 'askUser.tool.js'), '/*! toonflowTool:{"name":"askUser","author":"Toonflow"} */\n')
    await writeFile(join(dataDirectory, 'tools', 'webSearch.tool.js'), '/*! toonflowTool:{"name":"webSearch","author":"我自己"} */\n')
    // 用户在工作台里改过的内置技能。
    await writeFile(join(dataDirectory, 'skills', 'canvas', 'SKILL.md'), '---\ndescription: 我改过\n---\n我改过的正文\n')
    const runtime = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    try {
      const url = await runtime.open()
      // 内置节点按新构建重新播种（剪辑台 Pro 正是靠这一步进到用户的数据目录）。
      expect(await readdir(join(dataDirectory, 'nodes'))).toContain('webEpisodeEditorProNode.umd.js')
      expect(await readFile(join(dataDirectory, 'nodes', 'videoNode.umd.js'), 'utf8')).not.toBe('// 旧构建\n')
      const tools = await readdir(join(dataDirectory, 'tools'))
      expect(tools).toEqual(expect.arrayContaining(['videoComposer.tool.js', 'novelToTxt.tool.js', 'workspace.tool.js', 'webSearch.tool.js']))
      expect(tools).not.toContain('askUser.tool.js')
      expect(tools).not.toContain('browser.tool.js')
      expect(tools).not.toContain('webFetch.tool.js')
      // 用户自己安装、名字不在内置清单里的包不动。
      expect(await readFile(join(dataDirectory, 'tools', 'mine.tool.js'), 'utf8')).toBe('// 用户自己装的工具\n')
      expect(await readFile(join(dataDirectory, 'nodes', 'initialized'), 'utf8')).not.toBe('')
      // 技能：新内置的补进来，用户改过的不覆盖。
      const skills = await readdir(join(dataDirectory, 'skills'))
      expect(skills).toEqual(expect.arrayContaining(['canvas', 'workflow', 'animal-pawnshop-marketing', 'koc-video', 'minimax-h3-prompt-optimizer']))
      expect(await readFile(join(dataDirectory, 'skills', 'canvas', 'SKILL.md'), 'utf8')).toBe('---\ndescription: 我改过\n---\n我改过的正文\n')
      expect(await readdir(join(dataDirectory, 'skills', 'canvas', 'references'))).toContain('videoProduction.md')
      // 数据目录在 .vibedev 下：节点脚本照样取得到。
      const { origin } = new URL(url)
      const token = new URL(url).searchParams.get('filmAccess')!
      for (const name of ['textNode', 'videoNode', 'webEpisodeEditorProNode']) {
        expect((await fetch(`${origin}/api/nodes/files?name=${name}`, { headers: { referer: `${origin}/s/${token}/` } })).status, name).toBe(200)
      }
      expect((await fetch(`${origin}/api/ext/read?name=ext-md`, { headers: { referer: `${origin}/s/${token}/` } })).status).toBe(200)
    } finally {
      await runtime.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  it('serves one workbench per data directory, and takes over a lock left behind', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-lock-'))
    const first = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    const second = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
    try {
      const url = await first.open()
      // A second window on the same data directory is refused, with the reason.
      await expect(second.open()).rejects.toThrow(/已被另一个窗口/)
      // Closing the first releases the directory for the next window.
      await first.stop()
      const taken = await second.open()
      expect(taken).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?filmAccess=/)
      await second.stop()
      // A lock naming a process that no longer exists is not honoured.
      await writeFile(join(dataDirectory, 'session.lock'), JSON.stringify({ pid: 999_999_999, startedAt: '2026-01-01T00:00:00.000Z' }))
      const third = new FilmRuntime(() => ({ media, asker }), { dataDirectory })
      await expect(third.open()).resolves.toMatch(/filmAccess=/)
      await third.stop()
    } finally {
      await first.close()
      await second.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})
