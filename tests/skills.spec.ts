import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSkillFile, registerFilmSkills, type SkillRegistryLike } from '../src/skills.js'

/**
 * The workbench's skills (written for its removed agent) join the session's skill
 * catalog: the model picks them by description, the user calls them with
 * `/vibedev-film`, `/film-workflow`, … Skills made in the workbench appear too.
 */
const packagedSkills = resolve(import.meta.dirname, '../apps/toonflow/build/skills')
const available = existsSync(join(packagedSkills, 'workflow', 'SKILL.md'))

type Provider = Parameters<Parameters<SkillRegistryLike['registerProvider']>[0]> extends [infer _C] ? ReturnType<Parameters<SkillRegistryLike['registerProvider']>[0]> : never

describe.skipIf(!available)('workbench skills in the session catalog', () => {
  let data: string
  let provider: Provider
  const lifetime = new AbortController()

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'film-skills-'))
    await mkdir(join(data, 'shot-list'), { recursive: true })
    await writeFile(join(data, 'shot-list', 'SKILL.md'), '---\nname: shot-list\ndescription: "按剧本出分镜表"\n---\n\n# 分镜表\n正文\n')
    await mkdir(join(data, 'Bad Name'), { recursive: true })
    await writeFile(join(data, 'Bad Name', 'SKILL.md'), '---\ndescription: x\n---\nbody')
    await mkdir(join(data, 'no-frontmatter'), { recursive: true })
    await writeFile(join(data, 'no-frontmatter', 'SKILL.md'), '# nothing')
    const registry: SkillRegistryLike = {
      registerProvider(create) {
        provider = create({ signal: lifetime.signal, invalidate: () => {} })
        return () => { lifetime.abort() }
      },
    }
    registerFilmSkills(registry, () => [data, packagedSkills])
  })
  afterAll(async () => {
    lifetime.abort()
    await rm(data, { recursive: true, force: true })
  })

  it('lists the entry skill, the packaged skills and the user skill, all model- and user-invocable', async () => {
    const listed = await provider.list({})
    const names = listed.map(skill => skill.name)
    expect(names).toEqual(expect.arrayContaining(['vibedev-film', 'film-workflow', 'film-canvas', 'film-shot-list']))
    expect(names).not.toContain('film-bad name')
    expect(names).not.toContain('film-no-frontmatter')
    for (const skill of listed) expect(skill.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(listed.find(skill => skill.name === 'film-shot-list')?.description).toBe('按剧本出分镜表')
  })

  it('loads a packaged skill with the film_call preface, its directory as resource base, and no frontmatter', async () => {
    const listed = await provider.list({})
    const workflow = listed.find(skill => skill.name === 'film-workflow')!
    expect(workflow.resourceBase).toEqual({ kind: 'directory', path: join(packagedSkills, 'workflow') })
    const loaded = await provider.get(workflow, {})
    expect(loaded?.content.startsWith('> 这是「影视工作台」（VibeDev Film）的技能「workflow」')).toBe(true)
    expect(loaded?.content).toContain('film_call')
    expect(loaded?.content).toContain(join(packagedSkills, 'workflow'))
    // The frontmatter (with its upstream links) is not part of the body.
    expect(loaded?.content).not.toContain('displayName: 视频制作工作流')
    expect(loaded?.content).not.toContain('github: https://github.com/HBAI-Ltd')
    expect(loaded?.content).toContain('# Toonflow 画布制作工作流')
  })

  it('loads the entry skill, which tells the model to open the workbench first', async () => {
    const entry = (await provider.list({})).find(skill => skill.name === 'vibedev-film')!
    const loaded = await provider.get(entry, {})
    expect(loaded?.content).toContain('film_studio_open')
    expect(loaded?.content).toContain('film-workflow')
  })

  it('reads the frontmatter description, quoted or not', () => {
    expect(parseSkillFile('---\ndescription: 直接写\n---\nbody')?.description).toBe('直接写')
    expect(parseSkillFile("---\ndescription: '单引号'\n---\nbody")?.description).toBe('单引号')
    expect(parseSkillFile('no frontmatter')).toBeUndefined()
  })
})
