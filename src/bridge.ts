import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { MediaService, Task } from './contracts.js'
import type { OneShotServices } from './oneshot.js'
import { handleAskRequest, handleWriteRequest } from './write-route.js'
import { handleFitRequest } from './fit-route.js'

const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
const localPath = z.string().min(1).max(2048).refine(value => !/^[\\/]|[:\u0000-\u001f]/.test(value)
  && value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'), '需要工作区内的相对路径')
const reference = z.object({ path: localPath, mimeType: z.string().min(1) }).strict()
const requestSchema = z.object({
  directory: z.string().min(1).max(4096),
  request: z.object({
    providerId: z.literal('vibedev').optional(), modelId: z.string().trim().min(1).max(256), prompt: z.string().trim().min(1).max(100000),
    outputDirectory: localPath.optional(), images: z.array(reference).max(64).optional(),
    videos: z.array(reference).max(64).optional(), audios: z.array(reference).max(64).optional(),
    firstFrame: reference.optional(), lastFrame: reference.optional(),
    ratio: z.string().regex(/^[1-9]\d*:[1-9]\d*$/).optional(), size: z.string().max(64).optional(),
    duration: z.number().finite().positive().optional(), resolution: z.string().max(64).optional(),
    generateAudio: z.boolean().optional(), mode: z.union([z.enum(['text', 'singleImage', 'startEndRequired', 'endFrameOptional', 'startFrameOptional']), z.array(z.string().regex(/^(image|video|audio)Reference:\d+$/))]).optional(),
  }).strict(),
}).strict()

const audioRequestSchema = z.object({
  directory: z.string().min(1).max(4096),
  request: z.object({
    providerId: z.literal('vibedev').optional(), modelId: z.string().trim().min(1).max(256),
    prompt: z.string().trim().max(100000).optional(),
    kind: z.enum(['music', 'podcast', 'speech']).optional(),
    lyrics: z.string().max(20000).optional(), genre: z.string().max(256).optional(), mood: z.string().max(256).optional(),
    gender: z.string().max(64).optional(), sourceUrl: z.string().url().max(4096).optional(),
    format: z.string().max(32).optional(), sampleRate: z.number().int().positive().optional(), watermark: z.boolean().optional(),
    audios: z.array(reference).max(16).optional(), outputDirectory: localPath.optional(),
    operationId: z.string().regex(/^[\w-]{1,80}$/).optional(),
    /** Only look the operation up (after a reload): never starts a task. */
    resume: z.boolean().optional(),
  }).strict(),
}).strict()

const AUDIO_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' }

function within(root: string, path: string): string {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw fail(400, '素材和输出必须位于当前工作区')
  return rel.replaceAll('\\', '/')
}

async function outputFolder(root: string, path: string): Promise<string> {
  const folder = resolve(root, path)
  within(root, folder)
  let parent = folder
  for (;;) {
    try { within(root, await realpath(parent)); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (dirname(parent) === parent) throw error
      parent = dirname(parent)
    }
  }
  await mkdir(folder, { recursive: true })
  const actual = await realpath(folder)
  within(root, actual)
  return actual
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 100 * 1024 * 1024) throw fail(413, '请求过大')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw fail(400, '请求 JSON 无效') }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** One VibeDev workspace as the project center lists it. */
export interface WorkspaceEntry { readonly id: string; readonly title: string; readonly path: string }

/** Private process bridge: requests reach account-owned services; credentials never cross this boundary. */
export async function startBridge(services: { media: MediaService; asker?: OneShotServices; skillRoots?: () => readonly string[]; workspaces?: () => readonly WorkspaceEntry[] }) {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const tasks = new Map<string, { directory: string; folder: string; kind: 'video' | 'audio' }>()
  const controllers = new Set<AbortController>()
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      if (req.headers.origin) throw fail(403, '此接口仅供 Film 服务使用')
      const received = Buffer.from(req.headers.authorization ?? (typeof req.headers['x-api-key'] === 'string' ? `Bearer ${req.headers['x-api-key']}` : ''))
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw fail(401, 'Film 接入凭证无效')
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (req.method === 'GET' && path === '/catalog') {
        // Media models only. Text is not a catalog of its own: every text job the
        // workbench has goes to the model of the VibeDev conversation (/write-prompt, /ask).
        // Audio models come as forms: only the fields each declares, with its price.
        const media = await services.media.models(controller.signal)
        const audio = typeof services.media.audioForms === 'function' ? await services.media.audioForms(controller.signal) : []
        json(res, 200, { text: [], media: media.filter(item => item.kind === 'image' || item.kind === 'video'), audio })
      } else if (req.method === 'POST' && path === '/media/audio') {
        const { directory: inputDirectory, request } = audioRequestSchema.parse(await bodyJson(req))
        if (typeof services.media.startAudio !== 'function' || typeof services.media.result !== 'function') {
          throw fail(400, '当前 VibeDev 账号插件还不支持音频生成，请在 VibeDev 生态里把账号插件更新到 0.3.1 或更新版本')
        }
        if (!isAbsolute(inputDirectory)) throw fail(400, '工作区目录必须是绝对路径')
        const directory = await realpath(inputDirectory)
        for (const item of request.audios ?? []) within(directory, await realpath(resolve(directory, item.path)))
        const folder = await outputFolder(directory, request.outputDirectory ?? 'assets/generated')
        if (request.resume === true) {
          // After a reload: follow the operation that was started, never start a new one.
          const recorded = request.operationId === undefined ? undefined : await services.media.task(request.operationId)
          if (!recorded) throw fail(404, '这次生成的任务记录已不存在，请重新生成')
          tasks.set(recorded.id, { directory, folder, kind: 'audio' })
          json(res, 200, await taskView(services.media, recorded, directory, folder, 'audio'))
          return
        }
        const task = await services.media.startAudio({
          model: request.modelId,
          ...request.kind === undefined ? {} : { kind: request.kind },
          ...request.prompt ? { prompt: request.prompt } : {},
          ...request.lyrics?.trim() ? { lyrics: request.lyrics } : {},
          ...request.genre?.trim() ? { genre: request.genre } : {},
          ...request.mood?.trim() ? { mood: request.mood } : {},
          ...request.gender?.trim() ? { gender: request.gender } : {},
          ...request.sourceUrl ? { sourceUrl: request.sourceUrl } : {},
          ...request.audios?.length ? { references: request.audios.map(item => item.path) } : {},
          ...request.format ? { format: request.format } : {},
          ...request.sampleRate === undefined ? {} : { sampleRate: request.sampleRate },
          ...request.watermark === undefined ? {} : { watermark: request.watermark },
          ...request.operationId === undefined ? {} : { operationId: request.operationId },
        }, { cwd: directory, folder, stem: `audio-${request.operationId ?? randomUUID()}` }, controller.signal)
        tasks.set(task.id, { directory, folder, kind: 'audio' })
        json(res, 200, await taskView(services.media, task, directory, folder, 'audio'))
      } else if (req.method === 'POST' && path === '/write-prompt') {
        // The node's "帮写" star and a text node's answer: the workbench skills' rules
        // for the node, one call on the conversation's model.
        const outcome = await handleWriteRequest(await bodyJson(req), services.asker, services.skillRoots?.() ?? [], controller.signal)
        json(res, outcome.status, outcome.body)
      } else if (req.method === 'POST' && path === '/ask') {
        // A plain one-shot question from node code (no tools, no agent).
        const outcome = await handleAskRequest(await bodyJson(req), services.asker, controller.signal)
        json(res, outcome.status, outcome.body)
      } else if (req.method === 'POST' && path === '/fit-options') {
        // What this model accepts, for the node panel: one implementation of the rules.
        const outcome = handleFitRequest(await bodyJson(req))
        json(res, outcome.status, outcome.body)
      } else if (req.method === 'GET' && path === '/workspaces') {
        // Every VibeDev workspace on this computer, for the project center: the
        // workbench looks for its projects in each of them. Paths only — no sessions.
        const listed = services.workspaces?.() ?? []
        json(res, 200, { workspaces: listed.map(({ id, title, path }) => ({ id, title, path })) })

      } else if (req.method === 'POST' && ['/media/image', '/media/video'].includes(path)) {
        const { directory: inputDirectory, request } = requestSchema.parse(await bodyJson(req))
        if (!isAbsolute(inputDirectory)) throw fail(400, '工作区目录必须是绝对路径')
        const directory = await realpath(inputDirectory)
        const refs = [...request.images ?? [], ...request.videos ?? [], ...request.audios ?? [], ...request.firstFrame ? [request.firstFrame] : [], ...request.lastFrame ? [request.lastFrame] : []]
        for (const item of refs) within(directory, await realpath(resolve(directory, item.path)))
        const folder = await outputFolder(directory, request.outputDirectory ?? 'assets/generated')
        const target = { cwd: directory, folder, stem: `film-${randomUUID()}` }
        if (path === '/media/image') {
          if (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame) throw fail(400, '生图仅支持图片参考')
          // The account service accepts pixel dimensions. Never silently drop an explicitly selected ratio.
          let size = request.size
          if (request.ratio) {
            const [w, h] = request.ratio.split(':').map(Number) as [number, number]
            if (size && /^\d+x\d+$/.test(size)) {
              const [sw, sh] = size.split('x').map(Number) as [number, number]
              if (Math.abs(sw / sh - w / h) > 0.02) throw fail(400, '图片尺寸与比例不一致，请重新选择')
            } else {
              const edge = size === '2K' ? 2048 : size === '4K' ? 4096 : 1024
              size = w >= h ? `${edge}x${Math.round(edge * h / w)}` : `${Math.round(edge * w / h)}x${edge}`
            }
          }
          if (size && !/^\d+x\d+$/.test(size) && size !== 'auto') throw fail(400, '请选择像素尺寸或画面比例')
          const result = await services.media.generateImages({ model: request.modelId, prompt: request.prompt, size, n: 1, references: request.images?.map(item => item.path) }, target, controller.signal)
          const output = await Promise.all(result.images.map(async image => {
            const actual = await realpath(image.absolutePath)
            within(folder, actual)
            return { path: within(directory, actual), mimeType: image.mediaType, mediaType: 'image' }
          }))
          json(res, 200, output)
        } else {
          const singleImage = request.mode === 'singleImage'
          if (singleImage && (request.images?.length !== 1 || request.firstFrame || request.lastFrame)) throw fail(400, '单图模式需要恰好一张图片参考')
          if (request.mode === 'startFrameOptional' && !request.firstFrame) throw fail(400, '账号模型暂不支持仅尾帧生成，请补充首帧或更换模式')
          const firstFrame = singleImage ? request.images![0]!.path : request.firstFrame?.path
          const mode = Array.isArray(request.mode) ? 'omni_reference' : request.mode === 'text' ? 'text_to_video'
            : request.mode === 'startEndRequired' ? 'first_last_frame'
              : request.mode === 'endFrameOptional' || request.mode === 'startFrameOptional' ? (request.lastFrame ? 'first_last_frame' : 'first_frame')
                : singleImage ? 'first_frame' : undefined
          const task = await services.media.startVideo({ model: request.modelId, prompt: request.prompt, mode,
            duration: request.duration, aspectRatio: request.ratio, resolution: request.resolution, generateAudio: request.generateAudio,
            firstFrame, lastFrame: request.lastFrame?.path,
            referenceImages: singleImage ? undefined : request.images?.map(item => item.path), referenceVideos: request.videos?.map(item => item.path), referenceAudios: request.audios?.map(item => item.path),
          }, target, controller.signal)
          tasks.set(task.id, { directory, folder, kind: 'video' })
          json(res, 200, await taskView(services.media, task, directory, folder, 'video'))
        }
      } else if (req.method === 'GET' && path.startsWith('/task/')) {
        const id = decodeURIComponent(path.slice('/task/'.length))
        const owner = tasks.get(id)
        const task = owner && await services.media.task(id)
        if (!owner || !task) throw fail(404, '找不到此 Film 任务')
        json(res, 200, await taskView(services.media, task, owner.directory, owner.folder, owner.kind))
      } else throw fail(404, '未知 Film 接口')
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const e = error as { status?: number; code?: string; message?: string; details?: { status?: number } }
        const status = error instanceof z.ZodError || e.code === 'ENOENT' ? 400 : e.status ?? e.details?.status ?? (e.code === 'NOT_SIGNED_IN' ? 401 : 500)
        json(res, status, { error: { code: e.code ?? 'FILM_REQUEST_FAILED', message: e.message ?? 'Film 请求失败' } })
      } else if (!res.destroyed) res.destroy()
    } finally {
      controllers.delete(controller)
      req.off('aborted', abort)
      res.off('close', abort)
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Film bridge did not bind')
  return { url: `http://127.0.0.1:${address.port}`, token, close: async () => {
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

async function taskView(media: MediaService, task: Task, directory: string, folder: string, kind: 'video' | 'audio') {
  const name = kind === 'video' ? '视频' : '音频'
  let files = task.outputs ?? []
  // A finished audio task is read through the account plugin's result: links are renewed and
  // a file that is missing is downloaded again — a query, never a new generation.
  if (task.status === 'completed' && kind === 'audio' && typeof media.result === 'function'
    && (files.length === 0 || files.some(output => !output.path))) files = await media.result(task.id) ?? files
  const outputs = task.status === 'completed' ? await Promise.all(files.map(async output => {
    if (!output.path) throw fail(502, `${name}已完成但账号插件尚未保存本地文件，请稍后重试`)
    const path = await realpath(output.path)
    within(folder, path)
    const extension = path.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = kind === 'video' ? 'video/mp4' : output.contentType?.startsWith('audio/') ? output.contentType : AUDIO_TYPES[extension] ?? 'audio/mpeg'
    return {
      path: within(directory, path), mimeType, mediaType: kind,
      ...output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds },
      ...output.originalSeconds === undefined ? {} : { originalSeconds: output.originalSeconds },
    }
  })) : undefined
  if (task.status === 'completed' && !outputs?.length) throw fail(502, `${name}任务没有输出文件`)
  return {
    id: task.id, status: task.status, ...(task.error ? { error: task.error } : {}), ...(outputs ? { outputs } : {}),
    ...task.settlement === undefined ? {} : { settlement: task.settlement },
    ...task.chargedCny === undefined ? {} : { chargedCny: task.chargedCny },
    ...task.estimatedCny === undefined ? {} : { estimatedCny: task.estimatedCny },
  }
}
