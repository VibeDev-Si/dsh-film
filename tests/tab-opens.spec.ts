import { describe, expect, it } from 'vitest'
import { TabOpens } from '../src/tab-opens.js'

/**
 * `film_studio_open` runs on the host; the tab opens in the browser. The browser
 * long-polls, so a request must reach a page that is waiting now, be kept for a
 * page that polls a moment later (reloading), and never be delivered twice.
 */
describe('tab open delivery', () => {
  it('hands a request to the page that is waiting', async () => {
    const opens = new TabOpens()
    const waiting = opens.wait(5_000)
    expect(opens.request('s1')).toEqual({ delivered: true })
    expect((await waiting).map(open => open.sessionId)).toEqual(['s1'])
  })

  it('keeps a request until the next poll, then never repeats it', async () => {
    const opens = new TabOpens()
    expect(opens.request('s1')).toEqual({ delivered: false })
    expect((await opens.wait(5_000)).map(open => open.sessionId)).toEqual(['s1'])
    expect(await opens.wait(50)).toEqual([])
  })

  it('lets a poll end empty on timeout, on abort and on unload', async () => {
    const opens = new TabOpens()
    expect(await opens.wait(20)).toEqual([])
    const controller = new AbortController()
    const aborted = opens.wait(5_000, controller.signal)
    controller.abort()
    expect(await aborted).toEqual([])
    const unloading = opens.wait(5_000)
    opens.dispose()
    expect(await unloading).toEqual([])
  })
})
