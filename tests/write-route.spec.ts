import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OneShotServices } from '../src/oneshot.js'
import { briefParts, handleAskRequest, handleWriteRequest } from '../src/write-route.js'

/**
 * 帮写 end to end, minus the network: the node brief (wired references in
 * {{ref N}} order, images, settings, canvas) plus the workbench skills' rules
 * for that node, asked once on the conversation's model.
 */
const skills = resolve(import.meta.dirname, '../apps/toonflow/build/skills')
const roots = existsSync(join(skills, 'workflow', 'SKILL.md')) ? [skills] : []
const controller = new AbortController()
const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`

function services(reply: string, seen: Record<string, unknown>[] = [], next: { provider: string; model: string } = { provider: 'vibedev-gateway', model: 'deepseek-v4' }): OneShotServices {
  return {
    llm: {
      async *stream(options) { seen.push(options); if (reply) yield { type: 'text-delta', index: 0, text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } },
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'off' }] } }),
    },
    sessionController: { projections: async () => ({ values: { modelSelection: { next } } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'vibedev-gateway', model: 'default' }) },
    attachments: { saveImage: async () => ({ attachmentId: 'img' }) },
  }
}

describe('the write-prompt endpoint', () => {
  it('writes with the conversation model and says which one', async () => {
    const outcome = await handleWriteRequest({ node: '视频生成', current: '一匹马', sessionId: 's1' }, services('一匹马在雪原上疾驰', [], { provider: 'deepseek-account', model: 'deepseek-chat' }), roots, controller.signal)
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ prompt: '一匹马在雪原上疾驰', provider: 'deepseek-account', model: 'deepseek-chat' })
  })

  it.skipIf(roots.length === 0)('uses the skill rules for the node model, and shows the wired images', async () => {
    const seen: Record<string, unknown>[] = []
    const outcome = await handleWriteRequest({
      kind: 'video', node: '视频生成', model: 'Seedance 2.5（VibeDev）', settings: { 时长: '10 秒', 比例: '9:16' },
      references: [{ order: 1, kind: 'IMAGE', title: '林夏', image: png }, { order: 2, kind: 'STRING', title: '第3场', text: '林夏推门而入。' }],
    }, services('ok', seen), roots, controller.signal)
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ imagesShown: 1 })
    const request = seen[0] as { system: string; messages: { content: { type: string; text?: string }[] }[] }
    expect(request.system).toContain('A9.2.0 最终格式硬门')
    expect(request.system).toContain('A0.1 剧情保真锁')
    const content = request.messages[0]!.content
    expect(content.some(part => part.type === 'image')).toBe(true)
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(text).toContain('{{ref 1}} 图片「林夏」')
    expect(text).toContain('{{ref 2}} 文本「第3场」')
    expect(text).toContain('林夏推门而入。')
    expect(text).toContain('时长 10 秒')
  })

  it('refuses a body it does not recognise instead of guessing', async () => {
    expect((await handleWriteRequest({ node: '' }, services('x'), roots, controller.signal)).status).toBe(400)
    expect((await handleWriteRequest({ node: 'x', extra: 1 }, services('x'), roots, controller.signal)).status).toBe(400)
    expect((await handleWriteRequest('nonsense', services('x'), roots, controller.signal)).status).toBe(400)
  })

  it('says what is missing rather than failing vaguely', async () => {
    const noHost = await handleWriteRequest({ node: '视频生成' }, undefined, roots, controller.signal)
    expect(noHost.status).toBe(503)
    expect(JSON.stringify(noHost.body)).toContain('模型服务')
    const empty = await handleWriteRequest({ node: '视频生成' }, services(''), roots, controller.signal)
    expect(empty.status).toBe(502)
  })

  it('reports cancellation as such', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const outcome = await handleWriteRequest({ node: '视频生成' }, services('x'), roots, aborted.signal)
    expect(outcome.status).toBe(499)
    expect(JSON.stringify(outcome.body)).toContain('取消')
  })
})

describe('the brief', () => {
  it('tells the model there are no references when none are wired, and keeps canvas nodes as background', () => {
    const text = briefParts({ node: '视频生成', canvas: { name: '画布1', nodes: [{ title: '剧本', type: '文本', text: '雨夜' }] } }, 'video').map(part => part.type === 'text' ? part.text : '').join('\n')
    expect(text).toContain('不要写参考绑定')
    expect(text).toContain('画布「画布1」上的其他节点')
    expect(text).toContain('不是本节点的参考')
  })
})

describe('the ask endpoint', () => {
  it('answers a plain question on the conversation model', async () => {
    const outcome = await handleAskRequest({ system: '解释错误', text: '{"error":"429"}' }, services('请求太频繁'), controller.signal)
    expect(outcome).toMatchObject({ status: 200, body: { text: '请求太频繁' } })
    expect((await handleAskRequest({ text: '' }, services('x'), controller.signal)).status).toBe(400)
  })
})
