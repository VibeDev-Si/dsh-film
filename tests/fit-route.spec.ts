import { describe, expect, it } from 'vitest'
import { handleFitRequest } from '../src/fit-route.js'

const body = (requested: Record<string, unknown>, capabilities: Record<string, unknown> = {
  modes: { text_to_video: { inputs: {}, durations: [5, 10], resolutions: ['480p', '720p'] } },
}) => ({ capabilities, requested })

describe('the fit endpoint', () => {
  it('answers with the options to use and nothing to block on', () => {
    const outcome = handleFitRequest(body({ mode: 'text_to_video', duration: 4, resolution: '1080p' }))
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ ok: true, problems: [], options: { mode: 'text_to_video', duration: 5, resolution: '480p' } })
    expect((outcome.body as { changes: string[] }).changes.length).toBe(2)
  })

  it('reports what must block submission', () => {
    const outcome = handleFitRequest(body({ mode: 'omni_reference', references: { image: 9 } }, {
      modes: { omni_reference: { inputs: { referenceImages: { min: 1, max: 4 } }, durations: [5], resolutions: ['720p'] } },
    }))
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ ok: false })
    expect(JSON.stringify(outcome.body)).toContain('最多 4 个')
  })

  it('refuses a malformed request instead of guessing', () => {
    expect(handleFitRequest({ requested: {} }).status).toBe(400)
    expect(handleFitRequest(body({ duration: -1 })).status).toBe(400)
    expect(handleFitRequest(body({ mode: 'x', references: { image: 1, other: 2 } })).status).toBe(400)
    expect(handleFitRequest('nope').status).toBe(400)
  })

  it('accepts a catalogue that grows new capability fields', () => {
    const outcome = handleFitRequest(body({ mode: 'text_to_video' }, {
      modes: { text_to_video: { inputs: {}, durations: [5], resolutions: ['720p'], futureFlag: true } },
      somethingNew: { nested: 1 },
    }))
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ ok: true })
  })
})
