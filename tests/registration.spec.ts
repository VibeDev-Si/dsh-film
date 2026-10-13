import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

/**
 * What the plugin registers for a given set of host services.
 *
 * The fake follows Cordis: services are properties of the context (and `get`),
 * `inject(names, fn)` runs `fn` only when every named service is present, and
 * `effect(cb)` runs `cb` now. Account plugin 0.2.x provides `vibedevMedia` but no
 * `vibedevGateway`; the agent tools must still appear there (they once required
 * both and were missing from every session).
 */
function host(services: Record<string, unknown>) {
  const tools: string[] = []
  const routes: string[] = []
  const methods: Record<string, readonly string[]> = {}
  const skills: string[] = []
  const all: Record<string, unknown> = {
    ...services,
    tools: { register: (definition: { name: string }) => { tools.push(definition.name); return () => {} } },
    connection: { fetch: { register: (route: { path: string; methods: readonly string[] }) => { routes.push(route.path); methods[route.path] = route.methods; return () => {} } } },
  }
  if ('skills' in services) {
    all.skills = { registerProvider: (create: (control: unknown) => { name: string }) => { skills.push(create({ signal: new AbortController().signal, invalidate: () => {} }).name); return () => {} } }
  }
  const context: Record<string, unknown> = {
    ...all,
    get: (name: string) => all[name],
    effect: (callback: () => unknown) => { callback() },
    inject: (names: string[], callback: (child: unknown) => void) => {
      if (names.every(name => all[name] !== undefined)) callback(context)
    },
  }
  return { context, tools, routes, methods, skills }
}

const media = { models: async () => [], generateImages: async () => ({}), startVideo: async () => ({}), task: async () => undefined }
const llm = { listProviders: () => [], listModels: async () => [] }

describe('plugin registration', () => {
  it('offers the agent tools with the media service alone (account plugin 0.2.x)', () => {
    const { context, tools } = host({ vibedevMedia: media, llm })
    apply(context as never, {})
    expect(tools).toEqual(expect.arrayContaining(['film_studio_open', 'film_tools', 'film_call']))
  })

  it('does not hand the agent a second model to write prompts: the agent writes them itself', () => {
    const { context, tools } = host({ vibedevMedia: media, llm })
    apply(context as never, {})
    expect(tools).not.toContain('film_write_prompt')
  })

  it('leaves the workbench tools out without the media service, but keeps the tab routes', () => {
    const { context, tools, routes } = host({ llm })
    apply(context as never, {})
    expect(tools).not.toContain('film_studio_open')
    expect(routes).toEqual(expect.arrayContaining(['/api/dsh-film-studio/open', '/api/dsh-film-studio/close', '/api/dsh-film-studio/opens']))
  })

  // Before installing an update, the VibeDev desktop app stops admitting API requests and waits for every
  // admitted request that is not a read (GET/HEAD/OPTIONS) to finish, and it gives that wait 10 s. The open
  // feed holds its request for up to 25 s; served as a POST, it made the wait outlast the deadline whenever
  // more than 10 s were left ("desktop update: task inspection timed out"). The feed only waits to be told
  // something, so it is a read.
  it('serves the tab open feed as a read, so installing an update never waits for the long poll', () => {
    const { context, methods } = host({ llm })
    apply(context as never, {})
    expect(methods['/api/dsh-film-studio/opens']).toEqual(['GET'])
  })

  it('registers the workbench skills with the session skill registry', () => {
    const { context, skills } = host({ vibedevMedia: media, skills: true })
    apply(context as never, {})
    expect(skills).toEqual(['vibedev-film'])
  })
})
