import { describe, expect, it } from 'vitest'
import { LOG_FILES_KEPT, START_COOLDOWN_MS, START_FAILURE_LIMIT, redactLine, requireAccountServices, staleLogs, startDelayMs } from '../src/runtime.js'

describe('the account services a workbench needs', () => {
  const media = { models: async () => [], generateImages: async () => ({ images: [] }), startVideo: async () => ({ id: 't', status: 'queued' }), task: async () => undefined }
  it('opens with the media service alone: text jobs use the VibeDev conversation model, not the account plugin', () => {
    const services = requireAccountServices({ media })
    expect(services.media).toBe(media)
    expect(Object.keys(services)).toEqual(['media'])
  })

  it('still refuses to start without the media service, naming what is missing', () => {
    expect(() => requireAccountServices({})).toThrow(/vibedevMedia/)
    expect(() => requireAccountServices({ media: { task: async () => undefined } })).toThrow(/vibedevMedia\.models/)
  })
})

describe('the start policy', () => {
  it('does not delay the first failure and backs off after that', () => {
    expect(startDelayMs(0)).toBe(0)
    expect(startDelayMs(1)).toBe(0)
    expect(startDelayMs(2)).toBe(500)
    expect(startDelayMs(3)).toBe(1_000)
    expect(startDelayMs(4)).toBe(2_000)
    // Capped, so a long outage does not turn into an unbounded wait.
    expect(startDelayMs(9)).toBe(5_000)
  })

  it('keeps the cooldown and the failure limit finite and stated', () => {
    expect(START_FAILURE_LIMIT).toBeGreaterThan(1)
    expect(START_COOLDOWN_MS).toBeGreaterThan(0)
    expect(START_COOLDOWN_MS).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('the session logs', () => {
  it('keeps the newest few and deletes the rest, oldest first', () => {
    const names = ['session-2026-10-10T01-00-00-000Z.log', 'session-2026-10-10T03-00-00-000Z.log', 'session-2026-10-10T02-00-00-000Z.log']
    expect(staleLogs(names)).toEqual([])
    const many = Array.from({ length: LOG_FILES_KEPT + 3 }, (_, index) => `session-2026-10-10T${String(Math.floor(index / 60)).padStart(2, '0')}-${String(index % 60).padStart(2, '0')}-00-000Z.log`)
    expect(staleLogs(many)).toEqual(many.slice(0, 3))
  })

  it('ignores files that are not session logs', () => {
    expect(staleLogs(['notes.txt', 'session-a.log'], 1)).toEqual([])
  })
})

describe('what a failed start may say to the user', () => {
  it('hides bearer tokens and long secrets, and bounds the line', () => {
    expect(redactLine('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer ***')
    expect(redactLine(`token=${'a'.repeat(64)} failed`)).toBe('token=*** failed')
    expect(redactLine(`x  ${'f'.repeat(32)}`)).toBe('x ***')
    expect(redactLine('y'.repeat(500)).length).toBe(200)
  })

  it('leaves an ordinary error line readable', () => {
    expect(redactLine('Error: ENOENT: no such file or directory, open D:\\film\\data\\config.json')).toBe('Error: ENOENT: no such file or directory, open D:\\film\\data\\config.json')
    expect(redactLine('  listen EADDRINUSE  ')).toBe('listen EADDRINUSE')
  })
})
