import { describe, expect, it } from 'vitest'
import { fitToModel } from '../src/model-options.js'

const seedance = {
  modes: {
    text_to_video: { inputs: {}, durations: [5, 10], resolutions: ['480p', '720p'] },
    first_last_frame: { inputs: { firstFrame: { min: 1, max: 1 }, lastFrame: { min: 1, max: 1 } }, durations: [5], resolutions: ['720p'] },
    omni_reference: { inputs: { referenceImages: { min: 1, max: 4 }, referenceVideos: { min: 0, max: 1 } }, durations: [5, 10], resolutions: ['720p'] },
  },
}

describe('fitting a node to the model it uses', () => {
  it('keeps a choice the model serves', () => {
    const check = fitToModel(seedance, { mode: 'text_to_video', duration: 10, resolution: '720p' })
    expect(check.problems).toEqual([])
    expect(check.options).toMatchObject({ mode: 'text_to_video', duration: 10, resolution: '720p' })
    expect(check.options.changes).toEqual([])
  })

  it('moves an unsupported duration or resolution into range and says so', () => {
    const check = fitToModel(seedance, { mode: 'text_to_video', duration: 4, resolution: '1080p' })
    expect(check.problems).toEqual([])
    expect(check.options.duration).toBe(5)
    expect(check.options.resolution).toBe('480p')
    expect(check.options.changes.join(' / ')).toMatch(/时长已改为 5 秒/)
    expect(check.options.changes.join(' / ')).toMatch(/清晰度已改为 480p/)
  })

  it('moves to another mode when the chosen one is gone, instead of failing silently', () => {
    const check = fitToModel(seedance, { mode: 'image_to_video', duration: 5 })
    expect(check.problems).toEqual([])
    expect(check.options.mode).toBe('text_to_video')
    expect(check.options.changes.join('')).toContain('生成模式已改为')
  })

  it('refuses what the mode cannot take: too many references, or a kind it does not accept', () => {
    expect(fitToModel(seedance, { mode: 'omni_reference', references: { image: 6 } }).problems).toEqual([expect.stringContaining('最多 4 个')])
    expect(fitToModel(seedance, { mode: 'omni_reference', references: { image: 1, audio: 2 } }).problems).toEqual([expect.stringContaining('不接受参考音频')])
    // A frame slot holds one image: two wired in is one too many, and it is named.
    expect(fitToModel(seedance, { mode: 'first_last_frame', references: { image: 2 } }).problems.join()).toContain('最多 1 个')
  })

  it('refuses a model whose capabilities could not be read', () => {
    const check = fitToModel({ modes: {}, unreadableModesVersion: 2 }, { mode: 'text_to_video', duration: 5 })
    expect(check.options.changes).toEqual([])
    expect(check.problems).toEqual([expect.stringContaining('能力目录读不出来')])
  })

  it('still fits a model that declares only flat lists', () => {
    const check = fitToModel({ durations: [5, 10], resolutions: ['720p'] }, { duration: 8 })
    expect(check.problems).toEqual([])
    expect(check.options).toMatchObject({ duration: 10, resolution: '720p' })
  })
})
