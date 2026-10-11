import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSections, topics, videoFamily, writingRules } from '../src/write-rules.js'

/**
 * 帮写 follows the workbench's own skills: the rules are quoted from the skill
 * files by heading, per node kind × model, and every section a recipe names must
 * exist in the packaged skills (a renamed heading would silently drop a rule).
 */
const skills = resolve(import.meta.dirname, '../apps/toonflow/build/skills')
const available = existsSync(join(skills, 'workflow', 'SKILL.md'))

describe('section extraction', () => {
  const doc = ['# T', '## A0. 输入', 'intro', '### A0.1 保真', 'keep', '#### A0.1.1 优先级', 'p', '### A0.2 其他', 'x', '```', '## A0.1 在代码块里', '```', '## A1. 语言', 'zh'].join('\n')
  it('takes a section with its subsections, up to the next heading of the same level', () => {
    expect(extractSections(doc, ['A0.1'])[0]).toBe(['### A0.1 保真', 'keep', '#### A0.1.1 优先级', 'p'].join('\n'))
  })
  it('does not confuse A0.1 with A0.1.1, and ignores headings in code fences', () => {
    expect(extractSections(doc, ['A0.1.1'])[0]).toBe('#### A0.1.1 优先级\np')
    expect(extractSections(doc, ['A0'])[0]).toContain('## A0.1 在代码块里')
  })
})

describe('model family and topics', () => {
  it('routes by the node model', () => {
    expect(videoFamily('seedance-2.5-pro')).toBe('seedance-2.5')
    expect(videoFamily('Seedance 2.0（VibeDev）')).toBe('seedance-2.0')
    expect(videoFamily('MiniMax-Hailuo-H3')).toBe('h3')
    expect(videoFamily('kling-v2.1')).toBe('other')
  })
  it('turns topic skills on only for their subject', () => {
    expect(topics('猫店主在当铺里鉴定一只包')).toEqual(['pawnshop'])
    expect(topics('一条防晒霜的种草口播')).toEqual(['koc'])
    expect(topics('雨夜重逢')).toEqual([])
  })
})

describe.skipIf(!available)('assembled from the packaged skills', () => {
  const cases = [
    { kind: 'video', model: 'seedance-2.5', must: ['A9.2.0 最终格式硬门', 'A0.1 剧情保真锁', 'A1.2.1'], mustNot: ['A9.1 Seedance 2.0', '用色彩与光线'] },
    { kind: 'video', model: 'seedance-2.0', must: ['A9.1 Seedance 2.0', 'A4.2 角色条目'], mustNot: ['A9.2.0'] },
    { kind: 'video', model: 'minimax-hailuo-h3', must: ['五条贯穿硬规则', 'Full-Reference 六字段格式', 'A0.1 剧情保真锁'], mustNot: ['A9.1 Seedance'] },
    { kind: 'video', model: 'kling-v2', must: ['A9.2.1 Timeline 写法', 'A0.1'], mustNot: ['A9.2.0'] },
    { kind: 'image', model: 'gpt-image-1', must: ['角色：特写与完整三视图', '场景：可复用的空间主视图', 'A12.1 首帧锁定'], mustNot: ['A9.2'] },
    { kind: 'audio', model: 'tts', must: ['A12.15 对白原文', '声音角色与视觉状态'], mustNot: ['A9'] },
    { kind: 'text', model: '', must: ['从创意写到可制作剧本', '用潜台词写有目的的对白'], mustNot: ['A9.2'] },
  ] as const
  for (const item of cases) {
    it(`${item.kind} · ${item.model || 'text'}: every named section is found`, async () => {
      const { system, sources } = await writingRules({ kind: item.kind, model: item.model, topicText: '', roots: [skills] })
      for (const text of item.must) expect(system).toContain(text)
      for (const text of item.mustNot) expect(system).not.toContain(text)
      for (const source of sources) {
        const [found, named] = /（(\d+)\/(\d+) 节）/.exec(source)!.slice(1).map(Number)
        expect(found, source).toBe(named)
      }
      expect(system.length).toBeLessThan(26_000)
    })
  }
  it('adds a topic skill when the project is about it', async () => {
    const { system } = await writingRules({ kind: 'video', model: 'seedance-2.5', topicText: '二奢回收，猫店主', roots: [skills] })
    expect(system).toContain('科普与营销准确性')
  })
})
