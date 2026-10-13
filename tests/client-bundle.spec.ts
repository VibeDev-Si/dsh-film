import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The client half must be loadable by the Host's module loader: one factory file
 * that asks for React from the module table instead of bundling its own copy.
 * Skipped until `npm run build:client` has produced it.
 */
const file = resolve(import.meta.dirname, '../client/client.js')
/** The Host loads the client half under the package name; a bundle registered under any other id never activates. */
const packageName = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { name: string }).name
const built = existsSync(file)

describe.skipIf(!built)('the built client half', () => {
  const source = built ? readFileSync(file, 'utf8') : ''

  it('is one loader factory registered under the package name, with nothing bundled that the Host provides', () => {
    expect(source.startsWith('window.__ModuleLoader__.load(')).toBe(true)
    expect(/^window\.__ModuleLoader__\.load\(\{\s*id: "([^"]+)"/.exec(source)?.[1]).toBe(packageName)
    expect(source).toContain('factory: (require)')
    // The factory hands the Host's loader the plugin's exports and ends the call.
    expect(source).toContain('return module.exports;')
    expect(source.trimEnd().endsWith('});')).toBe(true)
    // React and the client primitives come from the module table, not from this bundle.
    expect(source).toContain('require("react")')
    expect(source).not.toMatch(/react-dom[^"']*\.production|createElement as jsx/)
    // No chunk files: this half has nothing to load lazily.
    expect(existsSync(resolve(import.meta.dirname, '../client/client.workbench.js'))).toBe(false)
  })

  it('registers the workbench tab and asks the plugin own route for the page link', () => {
    expect(source).toContain('sidebarRightTabs')
    expect(source).toContain('sidebar.right.pane.tab')
    expect(source).toContain('dsh-film-studio')
    expect(source).toContain('api/dsh-film-studio/open')
  })

  // The Host serves the open feed as GET only (see registration.spec.ts); a POST would get 404 and never open a tab.
  it('polls the tab open feed with GET, the method the Host route serves', () => {
    expect(source).toMatch(/fetch\("api\/dsh-film-studio\/opens",\s*\{\s*method: "GET"/)
  })
})
