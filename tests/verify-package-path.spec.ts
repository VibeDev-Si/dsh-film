import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
})

describe('package verification from a local archive', () => {
  it('installs a local tgz whose parent directory contains Chinese characters and spaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'film-package-path-'))
    directories.push(directory)
    const source = join(directory, 'source')
    const packaged = join(source, 'package')
    mkdirSync(packaged, { recursive: true })
    writeFileSync(join(packaged, 'package.json'), JSON.stringify({ name: 'film-path-fixture', version: '0.0.0', type: 'module' }))
    // Deliberately no Bun dependency: the check should install this archive, then reach the explicit runtime check.
    const bundleDirectory = join(directory, '中文交接目录 with spaces 2')
    mkdirSync(bundleDirectory)
    const archive = join(bundleDirectory, 'film-path-fixture-0.0.0.tgz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'package'], { encoding: 'utf8', timeout: 30_000 })
    expect(packed.status, packed.stderr).toBe(0)
    const temp = join(directory, 'temporary')
    mkdirSync(temp)
    const result = spawnSync(process.execPath, [resolve('scripts/verify-package.mjs'), archive], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp },
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toContain('缺少 Bun 运行时')
    expect(result.stderr).not.toContain('npm error')
  })
})
