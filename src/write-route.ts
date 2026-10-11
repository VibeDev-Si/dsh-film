/**
 * "帮写" and the workbench's other fixed writing jobs, as transport-agnostic handlers.
 *
 * - `handleWriteRequest`: one node's prompt (or a text node's content). The page
 *   collects the node — its model and settings, what the person typed, every
 *   wired reference in `{{ref N}}` order (text in full, images as small JPEGs,
 *   how each upstream item was made) and the rest of the canvas — and this
 *   assembles the workbench skills' rules for that node kind × model
 *   (`write-rules.ts`) and asks the conversation's model once (`oneshot.ts`).
 * - `handleAskRequest`: a plain one-shot question (system + text + images), for
 *   node code that asks the model directly (a text node's chat, explaining an
 *   error, a third-party node's AI edit) — no tools, no agent.
 */
import { z } from 'zod'
import { askOnce, OneShotError, type OneShotPart, type OneShotServices } from './oneshot.js'
import { writingRules, type WriteKind } from './write-rules.js'

const short = (max: number) => z.string().max(max)
const dataImage = z.string().max(1_200_000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)

const referenceSchema = z.object({
  order: z.number().int().min(1).max(64),
  kind: z.enum(['STRING', 'IMAGE', 'VIDEO', 'AUDIO']),
  title: short(200).optional(),
  text: short(20_000).optional(),
  image: dataImage.optional(),
  /** How the upstream node made this item (its own prompt), when it has one. */
  prompt: short(8_000).optional(),
  /** What feeds that upstream node, one level further up. */
  upstream: z.array(z.object({ kind: short(20), title: short(200).optional(), text: short(4_000).optional() }).strict()).max(8).optional(),
}).strict()

/** The node brief the workbench sends; unknown fields are refused, not ignored. */
export const writeRequestSchema = z.object({
  kind: z.enum(['video', 'image', 'audio', 'text']).optional(),
  node: z.string().trim().min(1).max(80),
  model: short(200).optional(),
  mode: short(200).optional(),
  settings: z.record(short(60), z.union([short(200), z.number().finite(), z.boolean()])).optional(),
  current: short(20_000).optional(),
  references: z.array(z.union([short(500), referenceSchema])).max(32).optional(),
  notes: z.array(short(500)).max(32).optional(),
  canvas: z.object({
    name: short(200).optional(),
    nodes: z.array(z.object({ title: short(200), type: short(80), text: short(600).optional() }).strict()).max(40).optional(),
  }).strict().optional(),
  sessionId: short(200).optional(),
  provider: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
}).strict()
export type WriteRequest = z.infer<typeof writeRequestSchema>

export interface WriteOutcome {
  readonly status: number
  readonly body: unknown
}

const fail = (status: number, message: string, code = 'FILM_WRITE_FAILED'): WriteOutcome => ({ status, body: { error: { code, message } } })

/** Decode a data URL into bytes. */
function decodeImage(url: string): Extract<OneShotPart, { type: 'image' }> | undefined {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(url)
  if (match === null) return undefined
  return { type: 'image', mediaType: match[1] as 'image/jpeg', data: new Uint8Array(Buffer.from(match[2]!, 'base64')) }
}

const KIND_NAMES: Record<string, string> = { STRING: '文本', IMAGE: '图片', VIDEO: '视频', AUDIO: '音频' }

/** The node brief as the user turn: text lines, with each wired image right after its line. */
export function briefParts(request: WriteRequest, kind: WriteKind): OneShotPart[] {
  const parts: OneShotPart[] = []
  const lines: string[] = []
  const flush = () => { if (lines.length) { parts.push({ type: 'text', text: lines.join('\n') }); lines.length = 0 } }
  lines.push(`节点：${request.node}`)
  if (request.model) lines.push(`目标模型：${request.model}`)
  if (request.mode) lines.push(`生成模式：${request.mode}`)
  const settings = Object.entries(request.settings ?? {}).map(([key, value]) => `${key} ${typeof value === 'boolean' ? (value ? '是' : '否') : value}`)
  if (settings.length) lines.push(`节点设置：${settings.join('；')}`)
  if (request.current?.trim()) {
    lines.push(kind === 'text' ? '用户的请求：' : '用户已经写的内容（保留其意图，在此基础上完善）：', request.current.trim())
  } else if (kind !== 'text') lines.push('用户还没有写内容：按参考与画布情况写一条可直接用于生成的提示词。')
  const references = request.references ?? []
  if (references.length) {
    lines.push('', `连线进来的参考（按 {{ref N}} 编号；文本、图片、视频、音频共用编号）：`)
    for (const [index, reference] of references.entries()) {
      if (typeof reference === 'string') { lines.push(`{{ref ${index + 1}}} ${reference}`); continue }
      const head = `{{ref ${reference.order}}} ${KIND_NAMES[reference.kind] ?? reference.kind}${reference.title ? `「${reference.title}」` : ''}`
      if (reference.kind === 'STRING') lines.push(`${head}：`, reference.text?.trim() || '（空）')
      else lines.push(`${head}${reference.image ? '：' : '（看不到内容，只按名字理解）'}`)
      if (reference.image) {
        flush()
        const image = decodeImage(reference.image)
        if (image) parts.push({ ...image, label: head })
      }
      if (reference.prompt?.trim()) lines.push(`　这项素材生成时的提示词：${reference.prompt.trim()}`)
      for (const item of reference.upstream ?? []) lines.push(`　它的上游：${KIND_NAMES[item.kind] ?? item.kind}${item.title ? `「${item.title}」` : ''}${item.text ? `：${item.text}` : ''}`)
    }
  } else if (kind !== 'text') lines.push('', '这个节点没有连线参考：不要写参考绑定或 {{ref N}}。')
  const others = request.canvas?.nodes ?? []
  if (others.length || request.canvas?.name) {
    lines.push('', `画布${request.canvas?.name ? `「${request.canvas.name}」` : ''}上的其他节点（只作背景了解项目，不是本节点的参考，不要写成 {{ref}}）：`)
    for (const node of others) lines.push(`- ${node.type}「${node.title}」${node.text ? `：${node.text}` : ''}`)
  }
  if (request.notes?.length) lines.push('', '其他约束：', ...request.notes.map(item => `- ${item}`))
  lines.push('', kind === 'text' ? '请写出要放进这个文本节点的内容。' : '请写出这个节点的提示词。')
  flush()
  return parts
}

/** Text the topic skills are chosen by: what the person wrote and what the project contains. */
function topicText(request: WriteRequest): string {
  return [
    request.current ?? '',
    ...(request.references ?? []).map(item => typeof item === 'string' ? item : [item.title, item.text, item.prompt].join(' ')),
    ...(request.canvas?.nodes ?? []).map(node => `${node.title} ${node.text ?? ''}`),
  ].join('\n')
}

const reply = (error: unknown, signal: AbortSignal): WriteOutcome => {
  if (signal.aborted) return fail(499, '已取消')
  if (error instanceof OneShotError) return fail(error.status, error.message, error.code)
  return fail(502, error instanceof Error ? error.message : '写作失败')
}

/**
 * Write one node's prompt (or a text node's content).
 * @param services - the host's model channel and friends; undefined when the host has no `llm`.
 * @param skillRoots - skill directories, the data directory's first.
 */
export async function handleWriteRequest(body: unknown, services: OneShotServices | undefined, skillRoots: readonly string[], signal: AbortSignal): Promise<WriteOutcome> {
  const parsed = writeRequestSchema.safeParse(body)
  if (!parsed.success) return fail(400, '写作请求格式无效')
  if (services === undefined) return fail(503, 'VibeDev Next 没有提供模型服务，无法写作；请在 VibeDev Next 里登录账号后重试')
  const request = parsed.data
  const kind: WriteKind = request.kind ?? 'video'
  try {
    const { system } = await writingRules({ kind, model: `${request.model ?? ''} ${request.modelId ?? ''}`, topicText: topicText(request), roots: skillRoots })
    const result = await askOnce(services, {
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      ...request.provider !== undefined && request.modelId !== undefined ? { route: { provider: request.provider, model: request.modelId } } : {},
      system,
      parts: briefParts(request, kind),
      signal,
    })
    if (result.text === '') return fail(502, '模型没有写出内容，请重试或换一个模型')
    return { status: 200, body: { prompt: result.text, provider: result.provider, model: result.model, imagesShown: result.imagesShown } }
  } catch (error) {
    return reply(error, signal)
  }
}

export const askRequestSchema = z.object({
  system: short(40_000).optional(),
  text: z.string().min(1).max(200_000),
  images: z.array(z.object({ data: z.string().max(30_000_000), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) }).strict()).max(8).optional(),
  sessionId: short(200).optional(),
}).strict()

/** A plain one-shot question on the conversation's model. */
export async function handleAskRequest(body: unknown, services: OneShotServices | undefined, signal: AbortSignal): Promise<WriteOutcome> {
  const parsed = askRequestSchema.safeParse(body)
  if (!parsed.success) return fail(400, '请求格式无效', 'FILM_ASK_FAILED')
  if (services === undefined) return fail(503, 'VibeDev Next 没有提供模型服务；请在 VibeDev Next 里登录账号后重试', 'FILM_ASK_FAILED')
  const request = parsed.data
  try {
    const result = await askOnce(services, {
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      system: request.system ?? '',
      parts: [
        { type: 'text', text: request.text },
        ...(request.images ?? []).map((image, index): OneShotPart => ({ type: 'image', mediaType: image.mediaType, data: new Uint8Array(Buffer.from(image.data, 'base64')), label: `图片 ${index + 1}` })),
      ],
      signal,
    })
    return { status: 200, body: { text: result.text, provider: result.provider, model: result.model, imagesShown: result.imagesShown } }
  } catch (error) {
    return reply(error, signal)
  }
}
