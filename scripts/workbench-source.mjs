/**
 * Which workbench (ToonFlow) source a package was built from.
 *
 * The npm package carries `apps/toonflow`, a build of the workbench made on one machine. A release records
 * the commit it was built from in `apps/toonflow/SOURCE.json`, and that commit must be committed and pushed
 * to the workbench repository — so anyone can rebuild exactly what users run, and nothing a user runs
 * exists only on one computer. `assemble-app.mjs` writes the stamp; `verify-package.mjs` refuses a package
 * without a released one.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/** The VibeDev workbench repository (private): branch `workbench`, tags `dsh-film-v<version>`. */
export const WORKBENCH_REPOSITORY = 'https://github.com/VibeDev-Si/dsh-film-studio'

/** `git+https://github.com/A/B.git/` and `https://github.com/a/b` name the same repository; a local path is resolved. */
function canonical(url) {
  const trimmed = String(url).trim().replace(/^git\+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.toLowerCase()
  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`.toLowerCase()
  return resolve(trimmed).toLowerCase()
}

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * The workbench commit a build in `directory` comes from.
 * @param {string} directory - the workbench checkout the build was made in.
 * @param {{ repository?: string, allowUnreleased?: boolean }} [options] - the workbench repository (default
 *   {@link WORKBENCH_REPOSITORY}); `allowUnreleased` records a dirty or unpushed checkout for local work.
 * @returns {{ repository: string, commit: string, released: boolean }}
 */
export function workbenchSource(directory, options = {}) {
  const repository = options.repository ?? WORKBENCH_REPOSITORY
  let commit
  try {
    commit = git(directory, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    throw new Error(`${directory} 不是工作台的 git 检出（git rev-parse HEAD 失败）`)
  }
  // Untracked files count: a build picks them up. Build output is ignored by the workbench itself.
  const dirty = git(directory, ['status', '--porcelain', '--untracked-files=normal']) !== ''
  const remotes = git(directory, ['remote', '-v']).split(/\r?\n/)
    .map(line => line.split(/\s+/))
    .filter(([, url, kind]) => kind === '(fetch)' && url !== undefined && canonical(url) === canonical(repository))
    .map(([name]) => name)
  const pushed = [...new Set(remotes)].some(name =>
    git(directory, ['branch', '-r', '--contains', commit, '--list', `${name}/*`]) !== '')
  const released = !dirty && pushed
  if (!released && options.allowUnreleased !== true) {
    const problems = [
      ...dirty ? ['有未提交的改动（含未跟踪文件）'] : [],
      ...pushed ? [] : [`提交 ${commit.slice(0, 10)} 未推送到 ${repository}`],
    ]
    throw new Error(`工作台源码不能用于发布：${problems.join('；')}。先提交并推送（git push vibedev HEAD:workbench），本地调试可加 --unreleased。`)
  }
  return { repository, commit, released }
}

/**
 * What is wrong with a package's source stamp; empty when it names a released build of the workbench.
 * @param {unknown} stamp - the parsed `apps/toonflow/SOURCE.json`, or undefined when it is missing.
 * @param {string} [repository] - the workbench repository.
 * @returns {string[]} the problems.
 */
export function checkSourceStamp(stamp, repository = WORKBENCH_REPOSITORY) {
  if (typeof stamp !== 'object' || stamp === null) return ['缺少 apps/toonflow/SOURCE.json（用 scripts/assemble-app.mjs 组装）']
  const problems = []
  if (typeof stamp.repository !== 'string' || canonical(stamp.repository) !== canonical(repository)) problems.push(`来源仓库不是 ${repository}`)
  if (typeof stamp.commit !== 'string' || !/^[0-9a-f]{40}$/.test(stamp.commit)) problems.push('来源提交不是完整的 40 位提交号')
  if (stamp.released !== true) problems.push('工作台是用未提交或未推送的源码构建的（--unreleased），不能发布')
  return problems
}
