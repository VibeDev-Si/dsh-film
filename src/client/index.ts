/**
 * Film Studio browser half: the workbench as one right-sidebar tab type, with
 * an entry box on the sidebar's guide page.
 *
 * Built by tsdown into the `__ModuleLoader__` factory bundle at
 * client/client.js; React and the client primitives come from the Host's module
 * table. The Host surfaces used here are typed structurally (see types.ts), so
 * this external package depends on no monorepo-internal types.
 */

import { ArtworkStudio } from './artwork.tsx'
import { en, zh } from './locales.ts'
import { addMediaToCanvas, TabBody } from './TabBody.tsx'
import type { ClientContext, HostBridge, SessionRemote } from './types.ts'

/**
 * The event another plugin dispatches on `window` to add media to the open canvas:
 * `detail = { paths: string[]; sessionId?: string; respond(result): void }`. The
 * workbench sets `detail.accepted = true` synchronously; still false after
 * dispatching means it is not installed.
 */
export const ADD_MEDIA_EVENT = 'vibedev-film:add-media'
interface AddMediaDetail {
  paths: unknown[]
  sessionId?: unknown
  accepted?: boolean
  respond: (result: { ok: boolean; added?: number; failed?: { path: string; reason: string }[]; message?: string }) => void
}

interface SidebarRightSurface {
  readonly mounted?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void
  openTabIn?(sessionId: string, kind: string, options?: { revealIfOpened?: boolean }): void
}

/**
 * Open (or bring forward) the workbench tab in a session. The session on screen
 * gets it at once; another session gets it as soon as it comes on screen, so an
 * agent working in the background never pulls the user away from what they view.
 */
function createTabOpener(ctx: ClientContext): (sessionId: string) => void {
  const waiting = new Set<string>()
  let unsubscribe: (() => void) | undefined
  const surface = () => ctx.get?.('sidebarRight') as SidebarRightSurface | undefined
  const flush = () => {
    const current = surface()?.mounted?.getSnapshot()
    if (current === undefined || !waiting.has(current)) return
    waiting.delete(current)
    surface()?.openTab(TAB_KIND, { revealIfOpened: true })
  }
  ctx.effect(() => () => { unsubscribe?.() }, 'dsh-film-studio: pending opens')
  return (sessionId) => {
    const sidebar = surface()
    if (sidebar === undefined) return
    if (sidebar.mounted?.getSnapshot() === sessionId) {
      sidebar.openTab(TAB_KIND, { revealIfOpened: true })
      return
    }
    waiting.add(sessionId)
    unsubscribe ??= sidebar.mounted?.subscribe(flush)
  }
}

/** The dictionary namespace this plugin owns. */
const LOCALE_NAMESPACE = 'dsh-film-studio'
/**
 * The tab type's identity, which is also the key its body registers under: the
 * registry wants a value unique across every registration, and a package name is
 * the natural one.
 */
const TAB_ID = 'dsh-film-studio'
/** The kind tabs of the workbench are opened with. */
const TAB_KIND = 'film-studio-workbench'
const VIEW = 'workbench'

export const name = 'dsh-film-studio'
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the dictionary, then the workbench tab type and its body.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-film-studio: dictionaries')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  // The Host desktop's own "show in folder", the same one its file tree uses.
  const host: HostBridge = {
    async reveal(path) {
      const session = (ctx.get?.('remote') as { session?: SessionRemote } | undefined)?.session
      if (session === undefined) return false
      try {
        const available = await session.canOpenWorkspacePath()
        if (!available.ok || available.value !== true) return false
        return (await session.openWorkspacePath({ path, action: 'reveal' })).ok
      } catch {
        return false
      }
    },
  }
  const openTab = createTabOpener(ctx)

  // Host → browser: `film_studio_open` asks for the workbench in a session's sidebar.
  ctx.effect(() => {
    const lifetime = new AbortController()
    void (async () => {
      while (!lifetime.signal.aborted) {
        try {
          const response = await fetch('api/dsh-film-studio/opens', { method: 'POST', credentials: 'same-origin', signal: lifetime.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json() as { opens?: { sessionId?: unknown }[] }
          for (const open of body.opens ?? []) if (typeof open.sessionId === 'string') openTab(open.sessionId)
        } catch {
          if (lifetime.signal.aborted) return
          await new Promise(resume => setTimeout(resume, 5_000))
        }
      }
    })()
    return () => { lifetime.abort() }
  }, 'dsh-film-studio: open feed')

  // Media gallery (or any plugin) → workbench: "add these files to the open canvas".
  // A DOM event keeps the two plugins independent: no event listener, no workbench.
  ctx.effect(() => {
    const onAddMedia = (event: Event) => {
      const detail = (event as CustomEvent<AddMediaDetail>).detail
      if (detail === null || typeof detail !== 'object' || !Array.isArray(detail.paths) || typeof detail.respond !== 'function') return
      detail.accepted = true
      const paths = detail.paths.filter((path): path is string => typeof path === 'string')
      void addMediaToCanvas(paths, typeof detail.sessionId === 'string' ? detail.sessionId : undefined, openTab)
        .then(detail.respond, (error: unknown) => { detail.respond({ ok: false, message: error instanceof Error ? error.message : String(error) }) })
    }
    window.addEventListener(ADD_MEDIA_EVENT, onAddMedia)
    return () => { window.removeEventListener(ADD_MEDIA_EVENT, onAddMedia) }
  }, 'dsh-film-studio: add media to canvas')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    // Hiding the tab, switching sessions or re-docking must not reload the workbench.
    keepMounted: true,
    title: () => t('tab.title'),
    guide: [{
      id: VIEW,
      order: 10,
      title: () => t('tab.title'),
      description: () => t('tab.guide.description'),
      icon: ArtworkStudio,
    }],
  }), 'dsh-film-studio: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: LOCALE_NAMESPACE, inject: () => ({ translate: t, view: VIEW, host }) },
    TabBody,
  )), 'dsh-film-studio: tab body')
}
