import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSourceStamp, WORKBENCH_REPOSITORY, workbenchSource } from '../scripts/workbench-source.mjs'

/**
 * The npm package carries a build of the workbench (ToonFlow) made on one machine. A release must say which
 * commit of the workbench source it was built from, and that commit must be committed and pushed to the
 * workbench repository, so anyone can rebuild what users run.
 */
const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A workbench checkout with one commit, and a bare repository standing in for the GitHub one. */
function checkout() {
  const origin = mkdtempSync(join(tmpdir(), 'workbench-origin-'))
  const work = mkdtempSync(join(tmpdir(), 'workbench-'))
  temporary.push(origin, work)
  git(origin, 'init', '--bare', '-q')
  git(work, 'init', '-q', '-b', 'workbench')
  git(work, 'config', 'user.email', 'test@example.invalid')
  git(work, 'config', 'user.name', 'test')
  git(work, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(work, '.gitignore'), '/build/\n')
  writeFileSync(join(work, 'source.ts'), 'export const a = 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'one')
  git(work, 'remote', 'add', 'vibedev', origin)
  return { work, origin, commit: git(work, 'rev-parse', 'HEAD') }
}

describe('workbench source of a release', () => {
  it('names the pushed commit of a clean checkout', () => {
    const { work, origin, commit } = checkout()
    git(work, 'push', '-q', 'vibedev', 'workbench')
    // Build output is ignored by the workbench, so a build does not make the checkout dirty.
    writeFileSync(join(work, '.gitignore'), '/build/\n')
    expect(workbenchSource(work, { repository: origin })).toEqual({ repository: origin, commit, released: true })
  })

  it('refuses a checkout with uncommitted changes', () => {
    const { work, origin } = checkout()
    git(work, 'push', '-q', 'vibedev', 'workbench')
    writeFileSync(join(work, 'source.ts'), 'export const a = 2\n')
    expect(() => workbenchSource(work, { repository: origin })).toThrow(/未提交/)
  })

  it('refuses untracked files, which a build would pick up', () => {
    const { work, origin } = checkout()
    git(work, 'push', '-q', 'vibedev', 'workbench')
    writeFileSync(join(work, 'new-node.ts'), 'export {}\n')
    expect(() => workbenchSource(work, { repository: origin })).toThrow(/未提交/)
  })

  it('refuses a commit that is not on the workbench repository', () => {
    const { work, origin } = checkout()
    expect(() => workbenchSource(work, { repository: origin })).toThrow(/未推送/)
  })

  it('refuses a commit pushed only to another repository (such as the upstream ToonFlow)', () => {
    const { work, origin } = checkout()
    const other = mkdtempSync(join(tmpdir(), 'workbench-other-'))
    temporary.push(other)
    git(other, 'init', '--bare', '-q')
    git(work, 'remote', 'add', 'origin', other)
    git(work, 'push', '-q', 'origin', 'workbench')
    expect(() => workbenchSource(work, { repository: origin })).toThrow(/未推送/)
  })

  it('records an unreleased build for local work when asked, and says so', () => {
    const { work, origin, commit } = checkout()
    writeFileSync(join(work, 'source.ts'), 'export const a = 2\n')
    expect(workbenchSource(work, { repository: origin, allowUnreleased: true })).toEqual({ repository: origin, commit, released: false })
  })

  it('refuses a directory that is not a git checkout', () => {
    const plain = mkdtempSync(join(tmpdir(), 'workbench-plain-'))
    temporary.push(plain)
    expect(() => workbenchSource(plain, { repository: 'x' })).toThrow(/git/)
  })

  it('defaults to the VibeDev workbench repository', () => {
    expect(WORKBENCH_REPOSITORY).toBe('https://github.com/VibeDev-Si/dsh-film-studio')
  })
})

describe('the source stamp a package must carry', () => {
  const commit = 'a'.repeat(40)
  it('accepts a released build of the workbench repository', () => {
    expect(checkSourceStamp({ repository: WORKBENCH_REPOSITORY, commit, released: true })).toEqual([])
  })
  it('refuses a missing stamp, an unreleased build, another repository or a malformed commit', () => {
    expect(checkSourceStamp(undefined)).not.toEqual([])
    expect(checkSourceStamp({ repository: WORKBENCH_REPOSITORY, commit, released: false })).not.toEqual([])
    expect(checkSourceStamp({ repository: 'https://github.com/HBAI-Ltd/Toonflow-app', commit, released: true })).not.toEqual([])
    expect(checkSourceStamp({ repository: WORKBENCH_REPOSITORY, commit: 'abc', released: true })).not.toEqual([])
  })
})
