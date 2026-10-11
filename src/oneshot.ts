/**
 * One question, one answer, on VibeDev Next's own model channel (`ctx.llm`).
 *
 * The workbench keeps no agent of its own. Fixed writing jobs that do not need
 * one — "帮写" a node's prompt, a text node's answer, explaining an error — are a
 * single model call made here, with the model of the conversation the
 * workbench tab belongs to (so a VibeDev-account, DeepSeek-account or own-key
 * user alike gets the model they picked). Nothing is added to that conversation.
 *
 * Request shape is the host's one-shot `GenerateOptions`: the instructions in
 * `system`, one user turn of content blocks (text, and images as attachments
 * when the model sees images). Reasoning is turned as low as the model allows,
 * so an answer comes in seconds; only `text-delta` is collected (reasoning
 * deltas carry text too and must not leak into the answer), and a `finish`
 * with an error is reported as that error rather than as an empty answer.
 */

/** A model route: provider id and model id (and the effort the user chose, unused here). */
export interface ModelRoute { provider: string; model: string }

/** What the caller sends: text, and images as bytes. */
export type OneShotPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; label?: string }

export interface OneShotRequest {
  /** The conversation whose current model answers; omitted → VibeDev Next's default model. */
  sessionId?: string
  /** An explicit route (e.g. the agent tool asked for one); wins over the conversation's. */
  route?: ModelRoute
  system: string
  parts: readonly OneShotPart[]
  maxTokens?: number
  signal: AbortSignal
}

export interface OneShotResult { text: string; provider: string; model: string; imagesShown: number }

/** The host services used, typed structurally (no monorepo types). */
export interface OneShotServices {
  llm: {
    stream(options: Record<string, unknown>): AsyncIterable<unknown>
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[]; reasoning?: { efforts: readonly { id: string }[] } }>
  }
  sessionController?: { projections(input: { sessionId: string }, signal: AbortSignal): Promise<{ values?: { modelSelection?: { next?: { provider?: unknown; model?: unknown } | null } } } | null> }
  agentDefaultModel?: { currentSelection(): { provider?: unknown; model?: unknown } }
  attachments?: { saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown> }
}

/** Images per request: the gateway refuses an over-large request whole. */
export const MAX_IMAGES = 6
const ANSWER_LIMIT = 40_000

export class OneShotError extends Error {
  override name = 'OneShotError'
  constructor(message: string, readonly code: string, readonly status = 502) { super(message) }
}

const route = (value: { provider?: unknown; model?: unknown } | null | undefined): ModelRoute | undefined =>
  typeof value?.provider === 'string' && value.provider !== '' && typeof value.model === 'string' && value.model !== ''
    ? { provider: value.provider, model: value.model }
    : undefined

/**
 * The model a conversation would use for its next message — the same rule the
 * model picker shows (`modelSelection.next`), falling back to the default.
 */
export async function conversationModel(services: OneShotServices, sessionId: string | undefined, signal: AbortSignal): Promise<ModelRoute | undefined> {
  if (sessionId !== undefined && sessionId !== '' && services.sessionController !== undefined) {
    const projected = await services.sessionController.projections({ sessionId }, AbortSignal.any([signal, AbortSignal.timeout(5_000)])).catch(() => null)
    const next = route(projected?.values?.modelSelection?.next)
    if (next !== undefined) return next
  }
  try { return route(services.agentDefaultModel?.currentSelection()) } catch { return undefined }
}

/** The lowest reasoning effort the model offers, or none to send (the model has no setting). */
export function quickEffort(efforts: readonly { id: string }[] | undefined): string | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined
  for (const id of ['off', 'none', 'minimal', 'low']) if (efforts.some(effort => effort.id === id)) return id
  return undefined
}

/** Failure messages people can act on. */
function explain(code: string, message: string): string {
  if (/SIGN_IN_REQUIRED/.test(code)) return '请先在 VibeDev Next 里登录账号'
  if (/INSUFFICIENT_BALANCE|QUOTA_EXCEEDED/.test(code)) return '账号余额或额度不足'
  if (code === 'TIMEOUT') return '模型响应超时，请重试'
  return message || '模型请求失败'
}

/**
 * Ask once.
 * @returns the answer text (trimmed), the route that answered and how many images the model saw.
 */
export async function askOnce(services: OneShotServices, request: OneShotRequest): Promise<OneShotResult> {
  if (request.signal.aborted) throw new OneShotError('已取消', 'ABORTED', 499)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])
  const selected = request.route ?? await conversationModel(services, request.sessionId, signal)
  if (selected === undefined) throw new OneShotError('当前没有可用的文本模型：请先在 VibeDev Next 里登录账号或选择模型', 'NO_MODEL', 503)
  const info = await services.llm.resolveModelInfo?.(selected.provider, selected.model, signal).catch(() => undefined)
  const seesImages = services.attachments !== undefined && info?.inputModalities?.includes('image') === true

  const content: Record<string, unknown>[] = []
  let imagesShown = 0
  for (const part of request.parts) {
    if (part.type === 'text') { if (part.text !== '') content.push({ type: 'text', text: part.text }); continue }
    const label = part.label ? `${part.label}` : '一张参考图'
    if (seesImages && imagesShown < MAX_IMAGES) {
      try {
        const attachment = await services.attachments!.saveImage({ data: part.data, mediaType: part.mediaType, name: 'film-reference' })
        content.push({ type: 'image', attachment })
        imagesShown += 1
        continue
      } catch { /* fall through to the note */ }
    }
    content.push({ type: 'text', text: `[${label}：${seesImages ? '这里读不到这张图' : '当前模型不看图片，只按名字理解'}]` })
  }
  if (content.length === 0) content.push({ type: 'text', text: '（没有更多信息）' })

  const effort = quickEffort(info?.reasoning?.efforts)
  const options: Record<string, unknown> = {
    provider: selected.provider,
    model: selected.model,
    system: request.system,
    messages: [{ role: 'user', content }],
    // With reasoning off a prompt needs little room; when it cannot be switched off, leave room for thinking.
    maxTokens: request.maxTokens ?? (effort === 'off' || effort === 'none' ? 2048 : 8192),
    ...effort === undefined ? {} : { reasoningEffort: effort },
    signal,
  }
  let text = ''
  for await (const raw of services.llm.stream(options)) {
    const chunk = raw as { type?: string; text?: unknown; reason?: { kind?: string; failure?: { message?: string; code?: string } } }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      if (text.length > ANSWER_LIMIT) break
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        if (request.signal.aborted) throw new OneShotError('已取消', 'ABORTED', 499)
        const code = chunk.reason?.failure?.code ?? 'MODEL_ERROR'
        throw new OneShotError(explain(code, chunk.reason?.failure?.message ?? ''), code)
      }
      if (kind === 'max-tokens' && text.trim() === '') throw new OneShotError('模型把输出额度用在了思考上，没有写出正文；请换一个模型或重试', 'MAX_TOKENS')
      break
    }
  }
  if (request.signal.aborted) throw new OneShotError('已取消', 'ABORTED', 499)
  return { text: text.trim(), provider: selected.provider, model: selected.model, imagesShown }
}
