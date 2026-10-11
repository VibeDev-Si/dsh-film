import { randomUUID } from 'node:crypto'

/** One request to show the workbench tab in a session's sidebar. */
export interface TabOpen {
  readonly id: string
  readonly sessionId: string
}

/**
 * Host → browser delivery of "open the workbench in this session's sidebar".
 *
 * A tool runs on the host; opening a sidebar tab is a browser action. Each
 * browser page long-polls {@link wait}; a request goes to every page waiting at
 * that moment and is then dropped (a page that reconnects must not reopen a tab
 * it already opened). With no page waiting the request is kept until the next
 * poll, so it is not lost while the page is reloading.
 */
export class TabOpens {
  private pending: TabOpen[] = []
  private readonly waiters = new Set<(opens: TabOpen[]) => void>()

  /** @returns whether a browser page was waiting and received it now. */
  request(sessionId: string): { delivered: boolean } {
    this.pending.push({ id: randomUUID(), sessionId })
    if (this.waiters.size === 0) return { delivered: false }
    const opens = this.take()
    for (const waiter of [...this.waiters]) waiter(opens)
    return { delivered: true }
  }

  /** Resolve with what is pending now, or the next requests, or nothing after `timeoutMs`. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<TabOpen[]> {
    if (this.pending.length > 0) return Promise.resolve(this.take())
    return new Promise((resolve) => {
      const done = (opens: TabOpen[]) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        this.waiters.delete(done)
        resolve(opens)
      }
      const aborted = () => { done([]) }
      const timer = setTimeout(() => { done([]) }, timeoutMs)
      signal?.addEventListener('abort', aborted, { once: true })
      this.waiters.add(done)
    })
  }

  /** Release every waiting page (plugin unload). */
  dispose(): void {
    for (const waiter of [...this.waiters]) waiter([])
    this.pending = []
  }

  private take(): TabOpen[] {
    const opens = this.pending
    this.pending = []
    return opens
  }
}
