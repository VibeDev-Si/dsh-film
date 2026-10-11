import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The workbench's skills, offered to the VibeDev session.
 *
 * The workbench no longer has an agent of its own; its skills (how to drive the
 * canvas, how to turn an idea, a novel or a script into a film) were written for
 * that agent. Registered here they join the session's own skill catalog, so:
 *
 * - the model picks them by description when the user asks for a drama, a
 *   storyboard, a promo… — no special syntax needed;
 * - the user can call them explicitly with `/vibedev-film`, `/film-workflow`, … in
 *   the composer, the same way as every other skill.
 *
 * Each body gets a short preface mapping the workbench's tool names onto
 * `film_call`, and the skill directory is its resource base, so the
 * `references/…` files it cites are read with the session's own file tools.
 * Skills the user created in the workbench (data/skills) are offered too; the
 * data directory copy wins over the packaged one.
 */

/** Same rule as the host registry (`isSkillName`). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The host's rank for bundled skills: project and user skills of the same name win. */
const BUNDLED_SKILL_RANK = 600
const PROVIDER = 'vibedev-film'
const ENTRY = 'vibedev-film'

interface Candidate {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
}

/** The slice of `ctx.skills` used here; typed structurally (no monorepo types). */
export interface SkillRegistryLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => {
    readonly name: string
    list(options: { signal?: AbortSignal }): Promise<readonly Candidate[]>
    get(candidate: Candidate, options: { signal?: AbortSignal }): Promise<(Omit<Candidate, 'rank' | 'locator'> & { content: string }) | undefined>
  }): () => void
}

type Locator = { kind: 'entry' } | { kind: 'file'; file: string; directory: string; original: string }

/** Split YAML frontmatter from the body; only `description` is needed from it. */
export function parseSkillFile(raw: string): { description: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match === null) return undefined
  const line = /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim()
  if (line === undefined || line === '') return undefined
  const description = line.replace(/^(["'])(.*)\1$/, '$2')
  return { description, body: raw.slice(match[0].length).trim() }
}

/** How a workbench skill maps onto the session's tools. */
export function preface(original: string, directory: string): string {
  return [
    `> 这是「影视工作台」（VibeDev Film）的技能「${original}」，原为工作台内置 agent 编写。在 VibeDev 对话里使用时：`,
    '> - 先调用 `film_studio_open` 在侧栏打开工作台（已打开会直接返回）。',
    '> - 文中提到的工作台工具（getCanvas、addNode、connectNodes、nodeTools、arrangeCanvas、listMediaModels、generateImage、generateVideo、generateAudio、videoComposer、convertNovelToTxt、assetOperator、skillOperator、workspaceFiles 等）都通过 `film_call` 调用：`film_call({ name: "<工具名>", args: { … } })`；不确定参数时先 `film_tools({ name: "<工具名>" })`。',
    '> - 文中的 read / write / edit / ls 等文件操作与"询问用户"，用你自己的文件工具和提问方式。',
    `> - 文中引用的 \`references/…\` 文件在本技能目录：\`${directory}\`。`,
    '> - 生成会使用用户已登录的 VibeDev 账号并产生费用：按用户的要求生成。',
  ].join('\n')
}

const entryContent = [
  '# 影视工作台（VibeDev Film）',
  '',
  '用户想做短剧、漫剧、动画、宣传片、MV、分镜、剧本，或者把创意、小说、剧本做成视频时使用。',
  '',
  '1. 调用 `film_studio_open`：在本对话的右侧栏打开影视工作台，直接进入本工作区的项目（工作区下的「VibeDev Film」文件夹）。',
  '2. `film_call({ name: "getAppState", args: {} })`：看当前项目、画布和可用的节点工具。',
  '3. 按用户的需求制作：完整流程（从创意/小说/剧本到图片资产、视频片段、成片）读技能 `film-workflow`；画布的具体操作（建节点、连线、调用节点功能、排版）读技能 `film-canvas`。',
  '4. 所有工作台操作都用 `film_call`，可用操作与参数用 `film_tools` 查看。',
  '',
  '3D 导演台（模型动画与运镜）没有自己的 agent，由你来编辑：先对导演台节点调用 `node:getDirector`，读它返回的 rules（人偶关节、关键帧、运镜的硬性规则）、已有方案、取景锚点和连线素材；再 `node:startPlanDraft`（写明本次指令）→ `node:readPlanDraft` / `node:editPlanDraft` → `node:savePlanDraft` 保存为新方案；需要时 `node:exportPlanVideo` 把方案渲染成画布上的视频节点，作为视频生成的动作/运镜参考。',
  '',
  '用户切到别的标签页或别的对话时工作台仍在后台运行，可以继续操作；用户关掉工作台标签页后先再调用 `film_studio_open`。',
  '生成会使用用户已登录的 VibeDev 账号并产生费用：按用户的要求生成，不做无关的试验性生成。',
].join('\n')

/**
 * Register the workbench skills with the session's skill registry.
 * @param skills - `ctx.skills`.
 * @param roots - where the workbench keeps its skills: the data directory first, then the packaged app.
 * @returns the registration disposer.
 */
export function registerFilmSkills(skills: SkillRegistryLike, roots: () => readonly string[], watched: () => readonly string[] = () => []): () => void {
  return skills.registerProvider((control) => {
    // A skill the user creates or edits in the workbench shows up without a restart.
    // Only the data directory is watched: on Windows a watched folder cannot be
    // renamed together with its parents, and the packaged skills only change when a
    // new version is installed — which a watch there blocked.
    const watchers: FSWatcher[] = []
    for (const root of watched()) {
      try { watchers.push(watch(root, { recursive: true }, () => { control.invalidate() })) } catch { /* not there yet */ }
    }
    control.signal.addEventListener('abort', () => { for (const watcher of watchers) watcher.close() }, { once: true })

    const entry: Candidate = {
      name: ENTRY,
      description: '影视创作入口：用户要做短剧、漫剧、动画、宣传片、MV、分镜、剧本，或把创意、小说、剧本做成视频时使用。打开影视工作台并在它的画布上按需求制作（节点、图片/视频/音频生成、剪辑成片）。',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled', provider: PROVIDER, rank: BUNDLED_SKILL_RANK, locator: { kind: 'entry' } satisfies Locator,
    }
    return {
      name: PROVIDER,
      async list(options) {
        const found = new Map<string, Candidate>()
        for (const root of roots()) {
          const directories = await readdir(root, { withFileTypes: true }).catch(() => [])
          for (const directory of directories) {
            if (!directory.isDirectory()) continue
            const name = `film-${directory.name.toLowerCase()}`
            if (found.has(name) || !SKILL_NAME.test(name) || name === ENTRY) continue
            const folder = join(root, directory.name)
            const file = join(folder, 'SKILL.md')
            const raw = await readFile(file, { encoding: 'utf8', ...options.signal === undefined ? {} : { signal: options.signal } }).catch(() => undefined)
            const parsed = raw === undefined ? undefined : parseSkillFile(raw)
            if (parsed === undefined) continue
            found.set(name, {
              name, description: parsed.description, path: file,
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'bundled', provider: PROVIDER, rank: BUNDLED_SKILL_RANK,
              resourceBase: { kind: 'directory', path: folder },
              locator: { kind: 'file', file, directory: folder, original: directory.name } satisfies Locator,
            })
          }
        }
        return [entry, ...found.values()]
      },
      async get(candidate, options) {
        const { rank: _rank, locator: rawLocator, ...summary } = candidate
        const locator = rawLocator as Locator
        if (locator.kind === 'entry') return { ...summary, content: entryContent }
        const raw = await readFile(locator.file, { encoding: 'utf8', ...options.signal === undefined ? {} : { signal: options.signal } }).catch(() => undefined)
        const parsed = raw === undefined ? undefined : parseSkillFile(raw)
        if (parsed === undefined) return undefined
        return { ...summary, content: `${preface(locator.original, locator.directory)}\n\n${parsed.body}` }
      },
    }
  })
}
