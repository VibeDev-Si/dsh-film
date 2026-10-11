import { describe, expect, it } from 'vitest'
import { askOnce, conversationModel, quickEffort, type OneShotServices } from '../src/oneshot.js'

/** The one-shot model call behind 帮写 / text nodes / error explanations. */
function services(over: Partial<OneShotServices> & { chunks?: unknown[]; seen?: Record<string, unknown>[] } = {}): OneShotServices {
  const seen = over.seen ?? []
  return {
    llm: over.llm ?? {
      async *stream(options) { seen.push(options); for (const chunk of over.chunks ?? [{ type: 'text-delta', index: 0, text: '雨夜街头' }, { type: 'finish', reason: { kind: 'stop' } }]) yield chunk },
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
    },
    ...over.sessionController === undefined ? {} : { sessionController: over.sessionController },
    agentDefaultModel: over.agentDefaultModel ?? { currentSelection: () => ({ provider: 'vibedev-gateway', model: 'default-model' }) },
    ...over.attachments === undefined ? {} : { attachments: over.attachments },
  }
}
const signal = () => new AbortController().signal

describe('which model answers', () => {
  it("uses the conversation's next model (what its model picker shows)", async () => {
    const s = services({ sessionController: { projections: async () => ({ values: { modelSelection: { next: { provider: 'deepseek-account', model: 'deepseek-chat' } } } }) } })
    expect(await conversationModel(s, 'session-1', signal())).toEqual({ provider: 'deepseek-account', model: 'deepseek-chat' })
  })

  it("falls back to VibeDev Next's default when the conversation has none or cannot be read", async () => {
    const empty = services({ sessionController: { projections: async () => null } })
    expect(await conversationModel(empty, 'session-1', signal())).toEqual({ provider: 'vibedev-gateway', model: 'default-model' })
    const broken = services({ sessionController: { projections: async () => { throw new Error('boom') } } })
    expect(await conversationModel(broken, 'session-1', signal())).toEqual({ provider: 'vibedev-gateway', model: 'default-model' })
  })
})

describe('the request', () => {
  it('sends system + one user turn of blocks, turns reasoning off, attaches images the model can see', async () => {
    const seen: Record<string, unknown>[] = []
    const saved: unknown[] = []
    const s = services({ seen, attachments: { saveImage: async (input) => { saved.push(input); return { attachmentId: 'a1' } } } })
    const result = await askOnce(s, { system: '规则', parts: [{ type: 'text', text: '节点：视频生成' }, { type: 'image', data: new Uint8Array([1]), mediaType: 'image/jpeg', label: '参考 1' }], signal: signal() })
    expect(result).toMatchObject({ text: '雨夜街头', provider: 'vibedev-gateway', model: 'default-model', imagesShown: 1 })
    expect(seen[0]).toMatchObject({ system: '规则', reasoningEffort: 'off', messages: [{ role: 'user', content: [{ type: 'text', text: '节点：视频生成' }, { type: 'image', attachment: { attachmentId: 'a1' } }] }] })
    expect(seen[0]).not.toHaveProperty('sessionId')
    expect(saved).toHaveLength(1)
  })

  it('describes images in words for a model that does not see them, without saving them', async () => {
    const seen: Record<string, unknown>[] = []
    const saved: unknown[] = []
    const s = services({
      seen,
      llm: { async *stream(options) { seen.push(options); yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } }, resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
      attachments: { saveImage: async (input) => { saved.push(input); return {} } },
    })
    await askOnce(s, { system: 's', parts: [{ type: 'image', data: new Uint8Array([1]), mediaType: 'image/png', label: '参考 1' }], signal: signal() })
    expect(saved).toHaveLength(0)
    expect(JSON.stringify(seen[0]?.messages)).toContain('当前模型不看图片')
  })

  it('keeps reasoning text out of the answer', async () => {
    const s = services({ chunks: [{ type: 'reasoning-delta', index: 0, text: '我想想…' }, { type: 'text-delta', index: 1, text: '正文' }, { type: 'finish', reason: { kind: 'stop' } }] })
    expect((await askOnce(s, { system: 's', parts: [], signal: signal() })).text).toBe('正文')
  })

  it('reports a failed request as its reason, not as an empty answer', async () => {
    const s = services({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'VIBEDEV_SIGN_IN_REQUIRED' } } }] })
    await expect(askOnce(s, { system: 's', parts: [], signal: signal() })).rejects.toThrow('请先在 VibeDev Next 里登录账号')
  })

  it('picks the lowest effort the model offers', () => {
    expect(quickEffort([{ id: 'low' }, { id: 'high' }])).toBe('low')
    expect(quickEffort([{ id: 'high' }, { id: 'off' }])).toBe('off')
    expect(quickEffort(undefined)).toBeUndefined()
  })
})
