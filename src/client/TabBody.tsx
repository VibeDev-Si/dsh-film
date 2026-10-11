/**
 * The tab body: the whole workbench in a frame, kept alive for as long as the tab.
 *
 * Lifecycle, as the user sees it:
 * - Opening plays a render animation; the frame loads behind it and appears
 *   only when the workbench says its canvas is on screen (`ready`), so there is
 *   no "starting…" text, no white flash and no second loading state.
 * - The tab type is `keepMounted`: hiding the tab, switching sessions or moving
 *   it between panes keeps the frame as it is — nothing reloads.
 * - Closing the tab (×) first asks the page to save everything, then removes
 *   the frame and releases this tab's hold on the workbench process; the plugin
 *   stops the process shortly after the last tab let go. The frame is moved
 *   (`moveBefore`, which keeps it alive) into a hidden holder for that final
 *   save, so closing can never cut a save short.
 *
 * The workbench is a separate local process on its own loopback origin; its
 * session link comes from this plugin's own route, never guessed.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HostBridge, TabHostProps, Translate } from './types.ts'

const CHANNEL = 'vibedev-film'
/** Longest a closing tab waits for the page's final save. */
const FLUSH_TIMEOUT_MS = 4_000
/** A body unmounted and mounted again this quickly (renderer, strict mode) keeps its frame. */
const REMOUNT_GRACE_MS = 600
/** A page that never says `ready` (an older build, an error page) is shown after this long. */
const SHOW_FALLBACK_MS = 6_000
/** How long to wait for the session's workspace before opening the project center instead. */
const WORKSPACE_WAIT_MS = 1_500

/**
 * The address to put in the frame.
 *
 * A cookie set inside a cross-origin frame may not be kept, so the session token
 * travels in the path (`/s/<token>/…`) and the app's relative requests carry it.
 * Other query parameters (the workspace to open) are kept, and `filmHost` names
 * this page's origin: the only origin the workbench talks to over postMessage.
 * `filmSession` names the VibeDev conversation the tab belongs to: "帮写" and the
 * workbench's other one-shot writing use that conversation's current model.
 * @param url - the entry link the host handed out.
 * @param host - this page's origin, when the frame should talk to it.
 * @param sessionId - the conversation the tab belongs to.
 * @returns the frame address, or the link itself when it carries no token.
 */
export function frameAddress(url: string, host?: string, sessionId?: string): string {
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('filmAccess')
    if (token === null || !/^[a-f0-9]{64}$/.test(token)) return url
    const query = new URLSearchParams(parsed.searchParams)
    query.delete('filmAccess')
    if (host !== undefined) query.set('filmHost', host)
    if (sessionId !== undefined && sessionId !== '') query.set('filmSession', sessionId)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return `${parsed.origin}/s/${token}/${suffix}${parsed.hash}`
  } catch {
    return url
  }
}

/** `dsh-resource://file/session/<id>/<path>`: how the Host's own preview names a file of this session. */
export function fileAddressFor(sessionId: string, workspace: string | undefined, path: string): string {
  const encode = (value: string) => value.split('/').map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
  const normalized = path.replace(/\\/g, '/')
  const root = workspace?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
  const relative = root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized
  return `dsh-resource://file/session/${encode(sessionId)}/${encode(relative)}`
}

/** One tab's frame, which outlives remounts of the body. */
interface Frame {
  readonly element: HTMLIFrameElement
  readonly origin: string
  readonly workspace: string | undefined
  readonly sessionId: string
  ready: boolean
  parked: boolean
}

/** The workbench frame to send "add these media" to: this session's first, then any. */
function frameFor(sessionId: string | undefined): Frame | undefined {
  const live = [...frames.values()].filter(frame => frame.ready && !frame.parked && frame.element.isConnected)
  return live.find(frame => frame.sessionId === sessionId) ?? live[0]
}

/**
 * Media gallery "add to canvas": hand absolute paths to the open workbench,
 * opening it in this session first when none is open.
 * @param paths - absolute media file paths.
 * @param sessionId - the session the request came from, if known.
 * @param openTab - opens the workbench tab in that session.
 * @returns what the canvas reported.
 */
export async function addMediaToCanvas(paths: readonly string[], sessionId: string | undefined, openTab: (sessionId: string) => void): Promise<{ ok: boolean; added?: number; failed?: { path: string; reason: string }[]; message?: string }> {
  let frame = frameFor(sessionId)
  if (frame === undefined && sessionId !== undefined) {
    openTab(sessionId)
    const deadline = Date.now() + 45_000
    while (frame === undefined && Date.now() < deadline) {
      await new Promise(resume => setTimeout(resume, 300))
      frame = frameFor(sessionId)
    }
  }
  if (frame === undefined) return { ok: false, message: '请先在侧栏打开影视工作台，并进入一个项目的画布' }
  const target = frame
  const id = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    const done = (result: { ok: boolean; added?: number; failed?: { path: string; reason: string }[]; message?: string }) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(result)
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { channel?: unknown; type?: unknown; id?: unknown; ok?: unknown; added?: unknown; failed?: unknown; message?: unknown } | null
      if (event.source !== target.element.contentWindow || data?.channel !== CHANNEL || data.type !== 'addMediaResult' || data.id !== id) return
      done({
        ok: data.ok === true,
        ...typeof data.added === 'number' ? { added: data.added } : {},
        ...Array.isArray(data.failed) ? { failed: data.failed as { path: string; reason: string }[] } : {},
        ...typeof data.message === 'string' ? { message: data.message } : {},
      })
    }
    // Large videos are copied on the workbench side; give them time.
    const timer = setTimeout(() => { done({ ok: false, message: '影视工作台没有回应，请稍后重试' }) }, 10 * 60_000)
    window.addEventListener('message', onMessage)
    post(target, { type: 'addMedia', id, paths: [...paths] })
  })
}

const frames = new Map<string, Frame>()
const canMove = typeof Element !== 'undefined' && typeof (Element.prototype as { moveBefore?: unknown }).moveBefore === 'function'

/** Put a frame into a parent without reloading it when the browser can (`moveBefore`). */
function place(parent: Element, element: HTMLIFrameElement): void {
  if (element.parentElement === parent) return
  if (canMove && element.isConnected) {
    try { (parent as Element & { moveBefore(node: Node, child: Node | null): void }).moveBefore(element, null); return } catch { /* fall back */ }
  }
  parent.appendChild(element)
}

let holderElement: HTMLDivElement | undefined
/** Off-screen home of frames finishing their last save. */
function holder(): HTMLDivElement {
  if (holderElement?.isConnected === true) return holderElement
  holderElement = document.createElement('div')
  holderElement.setAttribute('aria-hidden', 'true')
  Object.assign(holderElement.style, { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '600px', overflow: 'hidden', pointerEvents: 'none', visibility: 'hidden' })
  document.body.appendChild(holderElement)
  return holderElement
}

function post(frame: Frame, message: Record<string, unknown>): void {
  frame.element.contentWindow?.postMessage({ channel: CHANNEL, ...message }, frame.origin)
}

/** Ask the page to write everything to disk; resolves when it answered or after the timeout. */
function flush(frame: Frame): Promise<void> {
  const target = frame.element.contentWindow
  if (target === null) return Promise.resolve()
  const id = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve() }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { channel?: unknown; type?: unknown; id?: unknown } | null
      if (event.source === target && data?.channel === CHANNEL && data.type === 'flushed' && data.id === id) done()
    }
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    post(frame, { type: 'flush', id })
  })
}

/** This tab no longer holds the workbench process. */
function release(lease: string): void {
  void fetch('api/dsh-film-studio/close', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lease }),
  }).catch(() => undefined)
}

/** The body went away: save, then close — unless it comes straight back. */
function park(lease: string): void {
  const frame = frames.get(lease)
  if (frame === undefined) return
  frame.parked = true
  if (canMove && frame.element.isConnected) place(holder(), frame.element)
  const saved = frame.element.isConnected ? flush(frame) : Promise.resolve()
  const graced = new Promise(resume => setTimeout(resume, REMOUNT_GRACE_MS))
  void Promise.all([saved, graced]).then(() => {
    if (!frame.parked || frames.get(lease) !== frame) return
    frame.element.remove()
    frames.delete(lease)
    release(lease)
  })
}

// The Host page itself is going away (reload, quit): let go of every tab's hold.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const lease of frames.keys()) release(lease) })

type Phase = 'loading' | 'shown' | 'failed'

/** Automatic reopens after the page reported the workbench gone: at most this many per window. */
const RECONNECT_LIMIT = 3
const RECONNECT_WINDOW_MS = 120_000
const reconnects = new Map<string, number[]>()

export function TabBody({ translate, host, sessionId, useSessions, useTabInfo }: { translate: Translate; view: string; host: HostBridge } & TabHostProps): ReactNode {
  const { tab } = useTabInfo()
  const lease = tab.id
  const workspace = useSessions(state => state.byId[sessionId]?.cwd)
  const container = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>(() => frames.get(lease)?.ready === true ? 'shown' : 'loading')
  const [reason, setReason] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [gaveUpWaiting, setGaveUpWaiting] = useState(false)
  // Read inside message handlers without re-subscribing them.
  const live = useRef({ actions: tab.actions, workspace, host })
  live.current = { actions: tab.actions, workspace, host }

  // A remount takes its frame back from the holder; an unmount parks it.
  useLayoutEffect(() => {
    const frame = frames.get(lease)
    if (frame !== undefined && container.current !== null) {
      frame.parked = false
      place(container.current, frame.element)
    }
    return () => { park(lease) }
  }, [lease])

  useEffect(() => {
    if (workspace !== undefined) return
    const timer = setTimeout(() => { setGaveUpWaiting(true) }, WORKSPACE_WAIT_MS)
    return () => { clearTimeout(timer) }
  }, [workspace])

  // Open the link and build the frame; never again while the frame lives, unless retried.
  useEffect(() => {
    const existing = frames.get(lease)
    if (existing !== undefined && !(existing.workspace === undefined && workspace !== undefined)) return
    if (workspace === undefined && !gaveUpWaiting) return
    const controller = new AbortController()
    if (existing === undefined) setPhase('loading')
    void (async () => {
      try {
        const response = await fetch('api/dsh-film-studio/open', {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lease, ...workspace === undefined ? {} : { workspace } }),
        })
        const body = await response.json() as { url?: unknown; error?: unknown }
        if (!response.ok || typeof body.url !== 'string') throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
        const parent = container.current
        if (controller.signal.aborted || parent === null) return
        frames.get(lease)?.element.remove()
        const element = document.createElement('iframe')
        element.title = translate('tab.title')
        element.allow = 'fullscreen; clipboard-read; clipboard-write; autoplay'
        Object.assign(element.style, { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' })
        const frame: Frame = { element, origin: new URL(body.url).origin, workspace, sessionId, ready: false, parked: false }
        // An older page build never announces itself: show it once it has had time to draw.
        element.addEventListener('load', () => {
          setTimeout(() => { if (frames.get(lease) === frame && !frame.ready) { frame.ready = true; setPhase('shown') } }, SHOW_FALLBACK_MS)
        }, { once: true })
        element.src = frameAddress(body.url, window.location.origin, sessionId)
        frames.set(lease, frame)
        parent.appendChild(element)
      } catch (error) {
        if (controller.signal.aborted) return
        setReason(error instanceof Error ? error.message : String(error))
        setPhase('failed')
      }
    })()
    return () => { controller.abort() }
  }, [lease, workspace, gaveUpWaiting, attempt, translate, sessionId])

  // What the page tells the Host, and what it asks of it.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frames.get(lease)
      if (frame === undefined || event.source !== frame.element.contentWindow || event.origin !== frame.origin) return
      const data = event.data as { channel?: unknown; type?: unknown; id?: unknown; path?: unknown } | null
      if (data?.channel !== CHANNEL) return
      const reply = (ok: boolean) => { post(frame, { type: 'result', id: data.id, ok }) }
      if (data.type === 'ready') {
        frame.ready = true
        setPhase('shown')
      } else if (data.type === 'reveal' && typeof data.path === 'string') {
        void live.current.host.reveal(data.path).then(reply, () => { reply(false) })
      } else if (data.type === 'preview' && typeof data.path === 'string') {
        try {
          live.current.actions.openResource(fileAddressFor(sessionId, live.current.workspace, data.path))
          reply(true)
        } catch {
          reply(false)
        }
      } else if (data.type === 'lost') {
        // The workbench process is gone (ended, crashed, restarted): open it again —
        // a fresh process and link — instead of leaving a page whose every request
        // fails with "Network Error". Bounded, so a process that cannot stay up is reported.
        const now = Date.now()
        const recent = (reconnects.get(lease) ?? []).filter(at => now - at < RECONNECT_WINDOW_MS)
        if (recent.length >= RECONNECT_LIMIT) {
          setReason(translate('app.lost'))
          setPhase('failed')
          return
        }
        reconnects.set(lease, [...recent, now])
        reopen.current()
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [lease, sessionId, translate])

  const retry = useCallback(() => {
    frames.get(lease)?.element.remove()
    frames.delete(lease)
    setPhase('loading')
    setAttempt(value => value + 1)
  }, [lease])
  const reopen = useRef(retry)
  reopen.current = retry

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={container} style={{ position: 'absolute', inset: 0, opacity: phase === 'shown' ? 1 : 0, transition: 'opacity 200ms ease' }} />
      {phase === 'loading' && <RenderAnimation label={translate('app.loading')} />}
      {phase === 'failed' && (
        <div role="alert" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '24px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-primary)' }}>{translate('app.failed')}</p>
          <p style={{ margin: 0 }}>{reason}</p>
          <p style={{ margin: 0, fontSize: '12px' }}>{translate('app.hint')}</p>
          <button type="button" onClick={retry}>{translate('app.retry')}</button>
        </div>
      )}
    </div>
  )
}

const STYLE_ID = 'dsh-film-studio-render-animation'
const STYLE = `
.dfs-render{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);pointer-events:none}
.dfs-strip{position:relative;display:flex;gap:6px;padding:12px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));overflow:hidden}
.dfs-strip::before,.dfs-strip::after{content:"";position:absolute;left:8px;right:8px;height:4px;background:repeating-linear-gradient(90deg,var(--dsw-alias-border-l2,rgba(127,127,127,.35)) 0 6px,transparent 6px 12px)}
.dfs-strip::before{top:4px}.dfs-strip::after{bottom:4px}
.dfs-frame{position:relative;width:38px;height:26px;border-radius:4px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.18));overflow:hidden}
.dfs-frame::after{content:"";position:absolute;inset:0;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,var(--dsw-alias-state-business-primary,#3b82f6),color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 45%,transparent));animation:dfs-fill 1.8s cubic-bezier(.65,0,.35,1) infinite}
.dfs-frame:nth-child(2)::after{animation-delay:.3s}.dfs-frame:nth-child(3)::after{animation-delay:.6s}.dfs-frame:nth-child(4)::after{animation-delay:.9s}
.dfs-sweep{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);transform:translateX(-100%);animation:dfs-sweep 1.8s ease-in-out infinite}
.dfs-brand{font-size:13px;letter-spacing:.08em}
@keyframes dfs-fill{0%{transform:scaleX(0);opacity:1}45%{transform:scaleX(1);opacity:1}80%{transform:scaleX(1);opacity:0}100%{transform:scaleX(0);opacity:0}}
@keyframes dfs-sweep{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.dfs-frame::after{animation:none;transform:scaleX(1);opacity:.6}.dfs-sweep{display:none}}
`

/** A short film strip whose frames render one after another: the loading state, with no text to read. */
function RenderAnimation({ label }: { label: string }): ReactNode {
  useLayoutEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    document.head.appendChild(style)
  }, [])
  return (
    <div className="dfs-render" role="status" aria-label={label}>
      <div className="dfs-strip" aria-hidden="true">
        <span className="dfs-frame" />
        <span className="dfs-frame" />
        <span className="dfs-frame" />
        <span className="dfs-frame" />
        <span className="dfs-sweep" />
      </div>
      <span className="dfs-brand" aria-hidden="true">VibeDev Film</span>
    </div>
  )
}
