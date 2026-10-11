export interface Translate {
  (key: string, options?: Record<string, unknown>): string
}

/** The slice of the client context this plugin uses; typed structurally, no monorepo types. */
export interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

export interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, render: unknown): unknown
}

export interface TabDefinition {
  id: string
  kind: string
  keepMounted?: boolean
  title: (address: string) => string
  guide: readonly { id: string; order: number; title: () => string; description: () => string; icon: unknown }[]
}

/** The Host Remote's session namespace, for the native "show in folder". */
export interface SessionRemote {
  canOpenWorkspacePath(): Promise<{ ok: boolean; value?: boolean }>
  openWorkspacePath(request: { path: string; action?: 'reveal' }): Promise<{ ok: boolean }>
}

export interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  get?(name: string): unknown
  locale: LocaleService
  slots: SlotsService
  sidebarRightTabs: { register(definition: TabDefinition): unknown }
}

/** What the Host gives every tab body (standard props plus the tab-information hook). */
export interface TabHostProps {
  readonly sessionId: string
  readonly useSessions: <T>(select: (state: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T
  readonly useTabInfo: () => {
    readonly tab: {
      readonly id: string
      readonly visible: boolean
      readonly actions: { openResource(address: string): void }
    }
  }
}

/** Host abilities this plugin forwards to the workbench page. */
export interface HostBridge {
  /** Show a file in the system file manager through the Host desktop; false when the Host cannot. */
  reveal(path: string): Promise<boolean>
}
