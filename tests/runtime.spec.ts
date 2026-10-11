import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FilmRuntime } from '../src/runtime.js'
import type { GatewayService, MediaService } from '../src/contracts.js'
import { nativeToolResponse } from './nativeStreams.js'

const sourceDirectory = process.env.FILM_TEST_SOURCE
describe.skipIf(!sourceDirectory)('real Toonflow server through Film runtime', () => {
  it('boots isolated, protects the UI, lists account models and preserves text tool calls', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'film-runtime-'))
    const seen: { path: string; body: Record<string, unknown> }[] = []
    const gateway: GatewayService = { version: 1,
      models: async () => ({ text: [
        { id: 'film-test', name: 'Film test', api: 'openai-completions', contextWindow: 32000, maxTokens: 4000 },
        { id: 'claude-film', name: 'Claude test', api: 'anthropic-messages', contextWindow: 32000, maxTokens: 4000 },
        { id: 'gpt-film', name: 'GPT test', api: 'openai-responses', contextWindow: 32000, maxTokens: 4000 },
      ], media: [
        { id: 'film-image', name: 'Image test', kind: 'image', inputModalities: ['text', 'image'] },
        { id: 'film-video', name: 'Video test', kind: 'video', inputModalities: ['text', 'image'], video: {
          modes: { first_frame: { inputs: { firstFrame: { min: 1, max: 1 } }, durations: [5, 10], resolutions: ['720p'] } },
        } },
      ] }),
      text: async (path, body) => {
        seen.push({ path, body })
        const native = nativeToolResponse(path)
        if (native) return native
        const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'film-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        return new Response(chunk({ role: 'assistant', content: 'ready' })
          + chunk({ tool_calls: [{ index: 0, id: 'call-film', type: 'function', function: { name: 'splitClip', arguments: '{"second":2}' } }] })
          + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      },
    }
    const media: MediaService = {
      generateImages: vi.fn(async (_request, target) => {
        const absolutePath = join(target.folder, target.stem + '.png')
        await writeFile(absolutePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64'))
        return { images: [{ absolutePath, mediaType: 'image/png' }] }
      }),
      startVideo: vi.fn(async (_request, target) => {
        const path = join(target.folder, target.stem + '.mp4')
        await writeFile(path, 'synthetic video output')
        return { id: 'test-video', status: 'completed', outputs: [{ path }] }
      }), task: async () => undefined,
    }
    const runtime = new FilmRuntime(() => ({ gateway, media }), { toonflowDirectory: sourceDirectory!, dataDirectory })
    try {
      const url = await runtime.open()
      const origin = new URL(url).origin
      expect((await fetch(origin + '/api/settings/get')).status).toBe(401)
      const bootstrap = await fetch(url, { redirect: 'manual' })
      expect(bootstrap.status).toBe(303)
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
      const headers = { cookie, origin, referer: origin + '/', 'x-toonflow-workspace': '1', 'content-type': 'application/json' }
      const settings = await (await fetch(origin + '/api/settings/get', { headers })).json()
      expect(settings.data.filmAccountManaged).toBe(true)
      expect(settings.data.customProviders).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'vibedevChat', apiKey: '', models: [expect.objectContaining({ id: 'film-test' })] })]))
      const models = await (await fetch(origin + '/api/ai/models', { headers })).json()
      expect(models.data).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'vibedevChat', modelId: 'film-test' })]))
      expect((await fetch(origin + '/api/providers/models', { method: 'POST', headers, body: '{}' })).status).toBe(403)
      const response = await fetch(origin + '/api/ai/generate', { method: 'POST', headers, body: JSON.stringify({
        providerId: 'vibedevChat', modelId: 'film-test', context: {
          messages: [{ role: 'user', content: 'split', timestamp: Date.now() }],
          tools: [{ name: 'splitClip', description: 'Split a clip', parameters: { type: 'object', properties: { second: { type: 'number' } }, required: ['second'] } }],
        },
      }) })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"type":"done"')
      expect(text).toContain('"name":"splitClip"')
      expect(text).toContain('"second":2')
      expect(seen[0]?.path).toBe('/v1/chat/completions')
      expect(seen[0]?.body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
      for (const [providerId, modelId, path] of [['vibedevAnthropic', 'claude-film', '/v1/messages'], ['vibedevResponses', 'gpt-film', '/v1/responses']]) {
        const result = await (await fetch(origin + '/api/ai/generate', { method: 'POST', headers, body: JSON.stringify({
          providerId, modelId, context: { messages: [{ role: 'user', content: 'split', timestamp: Date.now() }],
            tools: [{ name: 'splitClip', description: 'Split a clip', parameters: { type: 'object', properties: { second: { type: 'number' } }, required: ['second'] } }],
          },
        }) })).text()
        expect(result, result).toContain('"type":"done"')
        expect(result).toContain('"name":"splitClip"')
        expect(result).toContain('"second":2')
        expect(seen.at(-1)?.path).toBe(path)
      }
      const mediaModels = await (await fetch(origin + '/api/ai/media/models', { headers })).json()
      expect(mediaModels.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerId: 'vibedev', modelId: 'film-video', mode: ['singleImage'], durationResolutionMap: [{ duration: [5, 10], resolution: ['720p'] }] }),
      ]))
      const image = await (await fetch(origin + '/api/ai/media/generate', { method: 'POST', headers, body: JSON.stringify({
        directory: dataDirectory, mediaType: 'image', providerId: 'vibedev', modelId: 'film-image', prompt: 'tree', ratio: '16:9', size: '1K',
      }) })).json()
      expect(image, JSON.stringify(image)).toMatchObject({ code: 200, data: [{ path: expect.stringMatching(/\.png$/) }] })
      expect(media.generateImages).toHaveBeenCalledWith(expect.objectContaining({ size: '1024x576' }), expect.anything(), expect.any(AbortSignal))
      const video = await (await fetch(origin + '/api/ai/media/generate', { method: 'POST', headers, body: JSON.stringify({
        directory: dataDirectory, mediaType: 'video', providerId: 'vibedev', modelId: 'film-video', prompt: 'move', mode: 'singleImage',
        duration: 5, resolution: '720p', images: [{ path: image.data[0].path, mimeType: 'image/png' }],
      }) })).json()
      expect(video, JSON.stringify(video)).toMatchObject({ code: 200, data: [{ path: expect.stringMatching(/\.mp4$/) }] })
      expect(media.startVideo).toHaveBeenCalledWith(expect.objectContaining({ mode: 'first_frame', firstFrame: image.data[0].path, referenceImages: undefined }), expect.anything(), expect.any(AbortSignal))
    } finally {
      await runtime.close()
      await new Promise(resolve => setTimeout(resolve, 300))
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 90000)
})
