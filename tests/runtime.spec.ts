import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FilmRuntime } from '../src/runtime.js'
import type { MediaService } from '../src/contracts.js'
import type { OneShotServices } from '../src/oneshot.js'

const sourceDirectory = process.env.FILM_TEST_SOURCE
describe.skipIf(!sourceDirectory)('real Toonflow server through Film runtime', () => {
  it('boots isolated, protects the UI and routes text and media to host services', async () => {
    const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), 'film-runtime-')))
    const seen: Record<string, unknown>[] = []
    const asker: OneShotServices = {
      llm: { async *stream(options) {
        seen.push(options)
        yield { type: 'text-delta', index: 0, text: 'ready' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'film-test', model: 'conversation-model' }) },
    }
    const media: MediaService = {
      models: async () => [
        { id: 'film-image', name: 'Image test', kind: 'image', inputModalities: ['text', 'image'] },
        { id: 'film-video', name: 'Video test', kind: 'video', inputModalities: ['text', 'image'], video: {
          modes: { first_frame: { inputs: { firstFrame: { min: 1, max: 1 } }, durations: [5, 10], resolutions: ['720p'] } },
        } },
      ],
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
    const runtime = new FilmRuntime(() => ({ asker, media }), { toonflowDirectory: sourceDirectory!, dataDirectory })
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
      const models = await (await fetch(origin + '/api/ai/models', { headers })).json()
      expect(models.data).toEqual([expect.objectContaining({ providerId: 'vibedev', modelId: 'conversation', label: '跟随 VibeDev 对话' })])
      expect((await fetch(origin + '/api/providers/models', { method: 'POST', headers, body: '{}' })).status).toBe(403)
      const context = { messages: [{ role: 'user', content: 'split', timestamp: 1 }] }
      const response = await fetch(origin + '/api/ai/generate', { method: 'POST', headers, body: JSON.stringify({
        providerId: 'vibedev', modelId: 'conversation', context,
      }) })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"type":"done"')
      expect(text).toContain('ready')
      expect(seen[0]).toMatchObject({ provider: 'film-test', model: 'conversation-model' })
      expect(JSON.stringify(seen[0]?.messages)).toContain('split')
      const loop = await fetch(origin + '/api/ai/generate', { method: 'POST', headers, body: JSON.stringify({
        providerId: 'vibedev', modelId: 'conversation', context: {
          ...context, tools: [{ name: 'splitClip', description: 'Split a clip', parameters: { type: 'object', properties: { second: { type: 'number' } }, required: ['second'] } }],
        },
      }) })
      const refused = await loop.text()
      expect(refused).toContain('"type":"error"')
      expect(refused).toContain('VibeDev 对话')
      expect(seen).toHaveLength(1)
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
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 90000)
})
