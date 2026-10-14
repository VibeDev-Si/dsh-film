import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBridge } from '../src/bridge.js'
import type { MediaService } from '../src/contracts.js'
import type { OneShotServices } from '../src/oneshot.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(options: { withoutAsker?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'film-bridge-'))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const imageModel = { id: 'image-1', name: 'Image', kind: 'image', inputModalities: ['text'] }
  const media: MediaService = { models: vi.fn(async () => [imageModel]), generateImages: vi.fn(async (_request, target) => {
    const path = join(target.folder, target.stem + '.png'); await writeFile(path, 'image')
    return { images: [{ absolutePath: path, mediaType: 'image/png' }] }
  }), startVideo: vi.fn(async () => ({ id: 'video-1', status: 'queued' })), task: async () => ({ id: 'video-1', status: 'running' }) }
  const asker: OneShotServices = {
    llm: { async *stream() { yield { type: 'text-delta', index: 0, text: '一匹马在雪原上疾驰' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'vibedev-gateway', model: 'deepseek-v4' }) },
  }
  const services = { ...(options.withoutAsker === true ? {} : { asker }), media }
  const bridge = await startBridge(services)
  cleanup.push(bridge.close)
  const call = (path: string, body?: unknown, token = bridge.token) => fetch(bridge.url + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { cwd, media, bridge, call }
}
describe('Film account bridge', () => {
  it('writes a node prompt on the conversation model, and says why it cannot', async () => {
    const { call } = await setup()
    const written = await call('/write-prompt', { node: '视频生成', references: ['图片：主角定妆照'] })
    expect(written.status).toBe(200)
    expect(await written.json()).toMatchObject({ prompt: '一匹马在雪原上疾驰', provider: 'vibedev-gateway', model: 'deepseek-v4' })
    const asked = await call('/ask', { system: '解释错误', text: '429' })
    expect(await asked.json()).toMatchObject({ text: '一匹马在雪原上疾驰' })
    // No host model service: the workbench still runs, but writing is unavailable with a reason.
    const { call: withoutAsker } = await setup({ withoutAsker: true })
    const refused = await withoutAsker('/write-prompt', { node: '视频生成' })
    expect(refused.status).toBe(503)
    expect(JSON.stringify(await refused.json())).toContain('模型服务')
  })
  it('lists media models only, and has no text-model passthrough', async () => {
    const { call, media } = await setup()
    const catalog = await (await call('/catalog')).json() as { text: unknown[]; media: { id: string }[] }
    expect(catalog.text).toEqual([])
    expect(catalog.media).toEqual([expect.objectContaining({ id: 'image-1' })])
    expect(media.models).toHaveBeenCalled()
    for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) expect((await call(path, { model: 'x', messages: [] })).status).toBe(404)
  })
  it('requires its own process credential and rejects browser-origin requests', async () => {
    const { call, bridge } = await setup()
    expect((await call('/catalog', undefined, 'bad')).status).toBe(401)
    expect((await fetch(bridge.url + '/catalog', { headers: { authorization: `Bearer ${bridge.token}`, origin: 'https://other.test' } })).status).toBe(403)
    expect((await call('/catalog')).status).toBe(200)
  })

  it('uses the existing media service and returns workspace-relative results', async () => {
    const { call, cwd, media } = await setup()
    const response = await call('/media/image', { directory: cwd, request: { modelId: 'image', prompt: 'a tree' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ path: expect.stringMatching(/^assets\/generated\/.+\.png$/), mimeType: 'image/png', mediaType: 'image' }])
    expect(media.generateImages).toHaveBeenCalledWith(expect.objectContaining({ model: 'image', n: 1 }), expect.objectContaining({ cwd }), expect.any(AbortSignal))
  })
  it('rejects output traversal and missing references before any paid request', async () => {
    const { call, cwd, media } = await setup()
    for (const request of [
      { modelId: 'image', prompt: 'tree', outputDirectory: '../escape' },
      { modelId: 'image', prompt: 'tree', images: [{ path: '../secret.png', mimeType: 'image/png' }] },
      { modelId: 'image', prompt: 'tree', images: [{ path: 'missing.png', mimeType: 'image/png' }] },
    ]) expect((await call('/media/image', { directory: cwd, request })).status).toBe(400)
    expect(media.generateImages).not.toHaveBeenCalled()
  })
  it('does not expose tasks owned by another caller, and refuses audio on an account plugin without it', async () => {
    const { call, cwd } = await setup()
    expect((await call('/media/audio', {})).status).toBe(400)
    expect((await call('/task/unowned')).status).toBe(404)
    const old = await call('/media/audio', { directory: cwd, request: { modelId: 'music', prompt: 'calm' } })
    expect(old.status).toBe(400)
    expect(JSON.stringify(await old.json())).toContain('0.3.1')
    // Without audio in the account plugin, the catalog simply lists none.
    expect(await (await call('/catalog')).json()).toMatchObject({ audio: [] })
  })
  it('lists audio forms and runs one audio operation under its key, reading the result by query', async () => {
    const { call, cwd, media } = await setup()
    const form = { model: 'seed-tts', name: 'Seed 语音', kind: 'speech', fields: [{ key: 'prompt', wire: 'text_prompt', required: true }], price: { priced: true, unit: 'original_second', label: { en: '¥0.015/s of original audio', zh: '¥0.015/原始秒' }, basis: { en: '', zh: '' } } }
    await writeFile(join(cwd, 'voice.wav'), 'RIFF')
    let saved = ''
    const recorded = new Map<string, { id: string; status: string; outputs?: { path?: string; contentType?: string; durationSeconds?: number; originalSeconds?: number }[]; settlement?: 'pending' }>()
    media.audioForms = vi.fn(async () => [form] as never)
    media.startAudio = vi.fn(async (request, target) => {
      const id = request.operationId ?? 'generated'
      const earlier = recorded.get(id)
      if (earlier) return earlier
      saved = join(target.folder, target.stem + '.mp3')
      await writeFile(saved, 'ID3')
      const task = { id, status: 'pending' }
      recorded.set(id, task)
      return task
    })
    media.task = vi.fn(async (id: string) => recorded.get(id))
    // The file is missing until the result is read through the account plugin, which renews the link and downloads it again.
    media.result = vi.fn(async () => [{ path: saved, contentType: 'audio/mpeg', durationSeconds: 4.2, originalSeconds: 5 }])
    // Prices travel with the models as the account plugin states them; the workbench shows them beside the send button.
    media.models = vi.fn(async () => [{ id: 'video-1', name: 'Video', kind: 'video', inputModalities: ['text'], pricing: { currency: 'CNY', tiers: [{ tier: '720p', unit: 'second', amount: 0.99 }] } }] as never)
    expect(await (await call('/catalog')).json()).toMatchObject({
      media: [{ id: 'video-1', pricing: { tiers: [{ tier: '720p', unit: 'second', amount: 0.99 }] } }],
      audio: [{ model: 'seed-tts', kind: 'speech', price: { label: { zh: '¥0.015/原始秒' } } }],
    })
    const body = { directory: cwd, request: { modelId: 'seed-tts', kind: 'speech', prompt: '你好', format: 'wav', sampleRate: 24000, watermark: false, audios: [{ path: 'voice.wav', mimeType: 'audio/wav' }], operationId: 'op-1', outputDirectory: 'assets/node-1' } }
    const started = await (await call('/media/audio', body)).json()
    expect(started).toMatchObject({ id: 'op-1', status: 'pending' })
    expect(media.startAudio).toHaveBeenCalledWith({ model: 'seed-tts', kind: 'speech', prompt: '你好', format: 'wav', sampleRate: 24000, watermark: false, references: ['voice.wav'], operationId: 'op-1' },
      expect.objectContaining({ cwd: expect.any(String), stem: 'audio-op-1' }), expect.any(AbortSignal))
    // The same click again: the recorded task, nothing new.
    await call('/media/audio', body)
    expect(recorded.size).toBe(1)
    recorded.set('op-1', { id: 'op-1', status: 'completed', outputs: [{ contentType: 'audio/mpeg' }], settlement: 'pending' })
    const done = await (await call('/task/op-1')).json()
    expect(done).toMatchObject({ status: 'completed', settlement: 'pending', outputs: [{ path: 'assets/node-1/audio-op-1.mp3', mimeType: 'audio/mpeg', mediaType: 'audio', durationSeconds: 4.2, originalSeconds: 5 }] })
    expect(media.result).toHaveBeenCalledWith('op-1')
  })
  it('keeps the video Token price and its issue on catalog models as the account plugin states them', async () => {
    const { call, media } = await setup()
    const videoPricing = { schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds', estimateOnly: true, rules: [
      { resolution: '480p', referenceVideo: false, pricePerMillionTokensCny: 60.06, estimatedPricePerSecondCny: 0.5819 },
      { resolution: '480p', referenceVideo: true, pricePerMillionTokensCny: 36.036, estimatedPricePerSecondCny: 0.6952 },
    ] }
    media.models = vi.fn(async () => [
      { id: 'video-sd-2.5(TC)', name: 'SD 2.5', kind: 'video', inputModalities: ['text'], videoPricing },
      { id: 'video-next', name: 'Next', kind: 'video', inputModalities: ['text'], videoPricingIssue: 'unknown-schema' },
    ] as never)
    expect((await (await call('/catalog')).json() as { media: unknown[] }).media).toEqual([
      expect.objectContaining({ id: 'video-sd-2.5(TC)', videoPricing }),
      expect.objectContaining({ id: 'video-next', videoPricingIssue: 'unknown-schema' }),
    ])
  })
  it('quotes a video price through the account plugin without generating, and says unsupported on an older plugin', async () => {
    const { call, media } = await setup()
    const request = { model: 'video-sd-2.5(TC)', resolution: '480p', durationSeconds: 7, references: { videos: [{ durationSeconds: 5 }, {}], images: 1, audios: 0 } }
    // An account plugin without videoQuote: answered, not an error, so the node can say so.
    const older = await call('/media/video-quote', { request })
    expect(older.status).toBe(200)
    expect(await older.json()).toEqual({ status: 'unsupported' })
    const quote = {
      status: 'estimate', mode: 'video_token', model: 'video-sd-2.5(TC)', currency: 'CNY', amountCny: '8.3424',
      estimatedPricePerSecondCny: 0.6952, pricePerMillionTokensCny: 36.036, outputSeconds: 7, referenceVideoSeconds: 5, billedSeconds: 12,
      rule: { resolution: '480p', referenceVideo: true }, estimateOnly: true, finalBasis: 'provider_tokens',
      label: { zh: '预计 ¥8.34 · 最终按实际视频 Token 结算', en: 'about ¥8.34 · billed by actual video Tokens' },
      basis: { zh: '¥0.6952/秒 × (7 秒输出 + 5 秒参考视频)，¥36.036/百万 Token', en: '' },
    }
    media.videoQuote = vi.fn(async () => quote as never)
    const answered = await call('/media/video-quote', { request })
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual(quote)
    expect(media.videoQuote).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    // Strict body: unknown fields, a zero (never "unknown") reference length and a missing request are refused first.
    for (const body of [{ request: { ...request, extra: 1 } }, { request, directory: 'C:/ws' }, { request: { ...request, references: { videos: [{ durationSeconds: 0 }] } } }, {}]) {
      expect((await call('/media/video-quote', body)).status).toBe(400)
    }
    expect(media.videoQuote).toHaveBeenCalledTimes(1)
    expect(media.startVideo).not.toHaveBeenCalled()
  })
  it('passes the settlement, its pending reason and the Token billing through the task views', async () => {
    const { call, cwd, media } = await setup()
    let output = ''
    media.startVideo = vi.fn(async (_request, target) => {
      output = join(target.folder, target.stem + '.mp4')
      await writeFile(output, 'video')
      // Completed: the video exists; only the charge is still being confirmed.
      return { id: 'video-1', status: 'completed', outputs: [{ path: output }], settlement: 'pending', settlementPendingReason: 'usage_counters_inconsistent', estimatedCny: '3.98' }
    })
    const started = await (await call('/media/video', { directory: cwd, request: { modelId: 'video', prompt: 'move' } })).json() as Record<string, unknown>
    expect(started).toMatchObject({ id: 'video-1', status: 'completed', settlement: 'pending', settlementPendingReason: 'usage_counters_inconsistent', estimatedCny: '3.98', outputs: [{ mediaType: 'video' }] })
    expect(started).not.toHaveProperty('chargedCny')
    media.task = async () => ({ id: 'video-1', status: 'completed', outputs: [{ path: output }], settlement: 'settled', chargedCny: '3.98066354', estimatedCny: '3.98', billing: { tokens: 100858 } })
    expect(await (await call('/task/video-1')).json()).toMatchObject({ status: 'completed', settlement: 'settled', chargedCny: '3.98066354', estimatedCny: '3.98', billing: { tokens: 100858 } })
  })
  it('resumes an audio operation after a reload without ever starting one', async () => {
    const { call, cwd, media } = await setup()
    media.startAudio = vi.fn(async () => ({ id: 'x', status: 'pending' }))
    media.result = vi.fn(async () => [])
    media.task = vi.fn(async () => undefined)
    const response = await call('/media/audio', { directory: cwd, request: { modelId: 'music', prompt: 'x', operationId: 'op-gone', resume: true } })
    expect(response.status).toBe(404)
    expect(media.startAudio).not.toHaveBeenCalled()
  })
  it('maps single-image references to a first frame and reads completed local video output', async () => {
    const { call, cwd, media } = await setup()
    await writeFile(join(cwd, 'frame.png'), 'image')
    let output = ''
    media.startVideo = vi.fn(async (_request, target) => {
      output = join(target.folder, target.stem + '.mp4')
      await writeFile(output, 'video')
      return { id: 'video-1', status: 'running' }
    })
    media.task = async () => ({ id: 'video-1', status: 'completed', outputs: [{ path: output }] })
    const response = await call('/media/video', { directory: cwd, request: {
      modelId: 'video', prompt: 'move', mode: 'singleImage', images: [{ path: 'frame.png', mimeType: 'image/png' }],
    } })
    expect(response.status).toBe(200)
    expect(media.startVideo).toHaveBeenCalledWith(expect.objectContaining({ mode: 'first_frame', firstFrame: 'frame.png', referenceImages: undefined }), expect.anything(), expect.any(AbortSignal))
    const task = await (await call('/task/video-1')).json()
    expect(task).toMatchObject({ status: 'completed', outputs: [{ path: expect.stringMatching(/^assets\/generated\/.+\.mp4$/) }] })
  })
  it('rejects frame modes that the account service cannot represent without discarding references', async () => {
    const { call, cwd, media } = await setup()
    await writeFile(join(cwd, 'frame.png'), 'image')
    const response = await call('/media/video', { directory: cwd, request: {
      modelId: 'video', prompt: 'move', mode: 'startFrameOptional', lastFrame: { path: 'frame.png', mimeType: 'image/png' },
    } })
    expect(response.status).toBe(400)
    expect(media.startVideo).not.toHaveBeenCalled()
  })
  it('propagates account sign-out and insufficient balance as structured errors', async () => {
    const { call, cwd, media } = await setup()
    media.models = async () => { throw Object.assign(new Error('Please sign in'), { code: 'NOT_SIGNED_IN' }) }
    expect((await call('/catalog')).status).toBe(401)
    media.generateImages = async () => { throw Object.assign(new Error('Insufficient balance'), { code: 'INSUFFICIENT_BALANCE', details: { status: 402 } }) }
    const response = await call('/media/image', { directory: cwd, request: { modelId: 'image', prompt: 'tree' } })
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } })
  })
})
