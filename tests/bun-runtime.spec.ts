import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bunRuntimeFor, installedBunRuntime } from '../scripts/bun-runtime.mjs'

describe('the Bun runtime installed with Film', () => {
  it.each([
    ['win32', 'x64', '@oven/bun-windows-x64', 'bun.exe'],
    ['darwin', 'arm64', '@oven/bun-darwin-aarch64', 'bun'],
    ['darwin', 'x64', '@oven/bun-darwin-x64', 'bun'],
  ])('selects the published package for %s-%s', (platform, architecture, packageName, executable) => {
    expect(bunRuntimeFor(platform, architecture)).toEqual({ packageName, executable })
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'film-bun-')))
    try {
      writeFileSync(join(directory, 'package.json'), '{}\n')
      const dependency = join(directory, 'node_modules', packageName)
      mkdirSync(join(dependency, 'bin'), { recursive: true })
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: packageName }))
      writeFileSync(join(dependency, 'bin', executable), 'runtime fixture\n')
      expect(installedBunRuntime(directory, platform, architecture)).toBe(join(dependency, 'bin', executable))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['linux', 'x64'], ['win32', 'arm64'], ['darwin', 'ia32'], ['freebsd', 'arm64'],
  ])('rejects unsupported %s-%s with the supported targets', (platform, architecture) => {
    expect(() => bunRuntimeFor(platform, architecture)).toThrow(`Film 不支持 ${platform}-${architecture}；支持 Windows x64、macOS arm64 和 macOS x64`)
    expect(() => installedBunRuntime('/absent-film', platform, architecture)).toThrow(`Film 不支持 ${platform}-${architecture}`)
  })
  it('permits a linked checkout without the optional runtime dependency', () => {
    const directory = mkdtempSync(join(tmpdir(), 'film-bun-absent-'))
    try {
      writeFileSync(join(directory, 'package.json'), '{}\n')
      expect(installedBunRuntime(directory, 'darwin', 'arm64')).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
