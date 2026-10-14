import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bunRuntimeFor } from '../scripts/bun-runtime.mjs'

const scratch: string[] = []
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'film-install-'))
  scratch.push(directory)
  const source = join(directory, 'source')
  const target = join(directory, 'installed')
  const put = (relative: string, content: string) => {
    const file = join(source, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('package.json', JSON.stringify({ name: 'film-install-fixture', version: '0.0.0', files: ['lib', 'client', 'apps', 'cordis.patch.yml'] }))
  put('lib/index.js', 'export default {}\n')
  put('client/client.js', '// client\n')
  put('cordis.patch.yml', '{}\n')
  put('apps/toonflow/build/server/film.js', '// server\n')
  put('apps/toonflow/build/web/index.html', '<script src="./assets/app.js"></script>\n')
  put('apps/toonflow/build/web/assets/app.js', '// web\n')
  put(`apps/toonflow/runtime/${process.platform === 'win32' ? 'bun.exe' : 'bun'}`, 'fixture runtime\n')
  return { directory, source, target, put }
}

const install = (target: string, source: string) => spawnSync(process.execPath, [resolve('scripts/install-app.mjs'), target, source], { encoding: 'utf8', timeout: 60_000 })

describe('installing the Film app', () => {
  it('accepts the current platform bundled runtime and replaces the old installation', () => {
    const { source, target } = fixture()
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old\n')
    const result = install(target, source)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(join(target, 'old.txt'))).toBe(false)
    expect(readFileSync(join(target, 'apps/toonflow/build/server/film.js'), 'utf8')).toBe('// server\n')
  })

  it('accepts an unpacked package with its platform optional Bun dependency', () => {
    const { directory, source, target, put } = fixture()
    const { packageName, executable } = bunRuntimeFor(process.platform, process.arch)
    rmSync(join(source, 'apps/toonflow/runtime'), { recursive: true })
    put(`node_modules/${packageName}/package.json`, JSON.stringify({ name: packageName }))
    put(`node_modules/${packageName}/bin/${executable}`, 'dependency runtime\n')
    const unpacked = join(directory, 'package')
    renameSync(source, unpacked)
    const result = install(target, unpacked)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(join(target, 'apps/toonflow/runtime'))).toBe(false)
    expect(readFileSync(join(target, 'node_modules', packageName, 'bin', executable), 'utf8')).toBe('dependency runtime\n')
  })

  it('rejects missing page assets and leaves the previous installation intact', () => {
    const { source, target } = fixture()
    rmSync(join(source, 'apps/toonflow/build/web/assets/app.js'))
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old\n')
    const result = install(target, source)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('index.html 引用的资源不存在')
    expect(readFileSync(join(target, 'old.txt'), 'utf8')).toBe('old\n')
  })
})
