import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The writing rules "帮写" follows, taken from the workbench's own skills.
 *
 * The workbench's built-in agent wrote a node's prompt by reading its skills —
 * `workflow` (with the embedded SEEDANCE EPISODE DIRECTOR · PART A), `canvas`,
 * the asset and method references, and the model- or topic-specific skills
 * (`minimax-h3-prompt-optimizer`, `koc-video`, `animal-pawnshop-marketing`).
 * The agent is gone; "帮写" is one model call. So the same rules are assembled
 * here per node kind × target model, quoted from the skill files by section
 * heading (not paraphrased, not by line number — a user's edited copy in the
 * data directory is read first and still matches), and framed for a single
 * node: the node's chosen model counts as the user's choice, one node is one
 * segment, nothing is asked, only the prompt is returned.
 *
 * Precedence, as the skills state it: PART A > the model's own format > topic
 * skills > methods. Seedance prompts never include the methods (the workflow's
 * hard isolation rule).
 */

/** A section is selected by the start of its heading text (outside code fences); it runs to the next heading of the same or a higher level. */
export function extractSections(markdown: string, ids: readonly string[]): string[] {
  const lines = markdown.split(/\r?\n/)
  const heads: { index: number; level: number; title: string }[] = []
  let fence = false
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) heads.push({ index, level: match[1]!.length, title: match[2]!.trim() })
  })
  const matches = (title: string, id: string) => title === id || (title.startsWith(id) && /^[\s（(：:、.，,—-]?$/.test(title.charAt(id.length)) && !/^\.\d/.test(title.slice(id.length)))
  const found: string[] = []
  for (const id of ids) {
    const at = heads.findIndex(head => matches(head.title, id))
    if (at < 0) continue
    const head = heads[at]!
    const next = heads.slice(at + 1).find(other => other.level <= head.level)
    found.push(lines.slice(head.index, next?.index ?? lines.length).join('\n').trim())
  }
  return found
}

export type WriteKind = 'video' | 'image' | 'audio' | 'text'
export type VideoFamily = 'seedance-2.5' | 'seedance-2.0' | 'h3' | 'other'

/** Which prompt format the node's model takes, from its id and name. */
export function videoFamily(model: string): VideoFamily {
  if (/seedance/i.test(model)) return /2\.?5/.test(model) ? 'seedance-2.5' : 'seedance-2.0'
  if (/hailuo|minimax/i.test(model) && /(?:^|[^0-9])(?:3|03|h3)(?:[^0-9]|$)|h3/i.test(model)) return 'h3'
  return 'other'
}

/** Topic skills, chosen by what the project is about. */
export function topics(text: string): ('koc' | 'pawnshop')[] {
  const found: ('koc' | 'pawnshop')[] = []
  if (/种草|测评|评测|开箱|口播|达人|带货|证言|UGC|KOC|无脸视角|手部实测|数字人/i.test(text)) found.push('koc')
  if (/典当|当铺|二奢|奢侈品回收|回收店|猫店主|狗店家/.test(text)) found.push('pawnshop')
  return found
}

type Pick = { skill: string; file: string; sections: string[]; note?: string }

const W = (sections: string[], note?: string): Pick => ({ skill: 'workflow', file: 'SKILL.md', sections, ...note === undefined ? {} : { note } })

/** PART A shared by every video prompt: fidelity, language, text, timing, staging, performance, stability, final polish. */
const VIDEO_BASE = W([
  'A0.1', 'A1.1', 'A1.3',
  'A3.2', 'A3.3', 'A3.5', 'A3.6',
  'A5.1', 'A5.3', 'A6', 'A7.4', 'A8.3',
  'A11.3', 'A11.4',
  'A12.1', 'A12.2', 'A12.3', 'A12.4', 'A12.6', 'A12.8', 'A12.11', 'A12.14', 'A12.15', 'A12.16', 'A12.17',
])

function recipe(kind: WriteKind, family: VideoFamily, topicList: readonly ('koc' | 'pawnshop')[]): Pick[] {
  const picks: Pick[] = []
  if (kind === 'video') {
    if (family === 'seedance-2.0') picks.push(VIDEO_BASE, W(['A4.1', 'A4.2', 'A4.3', 'A4.4', 'A4.5', 'A9.1']))
    else if (family === 'seedance-2.5') picks.push(VIDEO_BASE, W(['A1.2.1', 'A9.2', 'A12.17.1']))
    else if (family === 'h3') {
      picks.push(W(['A0.1', 'A1.3', 'A12.15'], '以下 PART A 规则仍然优先：H3 手册里 Closing Beat、非说话角色情绪等写法如果会新增剧本里没有的动作，只写已有动作或"嘴唇闭合"这类状态。'))
      picks.push({ skill: 'minimax-h3-prompt-optimizer', file: 'SKILL.md', sections: ['语言策略', '先分任务类型', '五条贯穿硬规则', '口型对准专项', '姿态与动作控制', '每类任务的写作要点', '负面约束', '写完自检清单'] })
      picks.push({ skill: 'minimax-h3-prompt-optimizer', file: 'references/h3-format-spec.md', sections: ['Base 三字段格式', 'Full-Reference 六字段格式', '运镜词表', '说话人与对白标签'] })
    } else {
      picks.push(VIDEO_BASE, W(['A9.2.1'], '这个模型不是 Seedance：只借用下面的时间块写法（用中文连续叙述，不使用 Seedance 2.5 的英文字段标题与九字段外壳）。'))
    }
  } else if (kind === 'image') {
    picks.push(W(['A0.1', 'A1.3', 'A12.1', 'A12.2', 'A12.3']))
    picks.push({ skill: 'workflow', file: 'references/assets.md', sections: ['按制作范围提取需求', '角色：特写与完整三视图', '场景：可复用的空间主视图', '道具：按识别需要展示结构', '准备生成与验收'] })
    picks.push({ skill: 'workflow', file: 'references/methods/visualDesign.md', sections: ['1. 先分清事实、约束与提案', '8. 把设计压缩成可使用的资产依据'] })
    picks.push({ skill: 'workflow', file: 'references/methods/colorAndLight.md', sections: ['2. 把物体本色、环境受光和后期观感分开', '6. 按媒介换控制对象', '9. 合入提示词并检查实际结果'] })
  } else if (kind === 'audio') {
    picks.push(W(['A1.1', 'A12.14', 'A12.15']))
    picks.push({ skill: 'workflow', file: 'references/assets.md', sections: ['声音角色与视觉状态'] })
  } else {
    picks.push({ skill: 'workflow', file: 'references/sourceAndScript.md', sections: ['先锁定本次范围', '小说或故事改编', '已定稿剧本直接进入制作', '从创意写到可制作剧本', '时长与连续性'] })
    picks.push({ skill: 'workflow', file: 'references/methods/storyDevelopment.md', sections: ['1. 先分清事实、提案与未知'] })
    picks.push({ skill: 'workflow', file: 'references/methods/screenAdaptation.md', sections: ['5. 用潜台词写有目的的对白', '8. 按实际展开估时', '10. 写清可制作的事件与连续性'] })
  }
  if (topicList.includes('koc')) {
    picks.push({ skill: 'koc-video', file: 'references/script-and-shots.md', sections: kind === 'text' ? ['0. 确定内容推进与 speech plan', '1. 写连续口播'] : ['1. 写连续口播', '4. 多 clip 边界', '5. 编译视频 Prompt'] })
    if (kind === 'video' || kind === 'audio') picks.push({ skill: 'koc-video', file: 'references/production.md', sections: ['4. 声音'] })
  }
  if (topicList.includes('pawnshop')) {
    picks.push({ skill: 'animal-pawnshop-marketing', file: 'SKILL.md', sections: kind === 'text' ? ['2. 必须保持的统一风格', '5. 60秒商业短剧结构', '6. 科普与营销准确性', '9. 禁止项'] : ['2. 必须保持的统一风格', '6. 科普与营销准确性', '7. Toonflow 生成友好规则', '9. 禁止项'] })
  }
  return picks
}

const KIND_LABEL: Record<WriteKind, string> = { video: '视频生成', image: '图片生成', audio: '音频生成', text: '文本' }

/** How the agent-process rules map onto one node written in one call. */
function framing(kind: WriteKind, family: VideoFamily): string {
  const lines = [
    `你在 VibeDev Film 影视工作台里，为画布上的一个「${KIND_LABEL[kind]}」节点${kind === 'text' ? '写这个文本节点的内容' : '写一条生成提示词'}。结果会直接填进节点的输入框，用户可以再改。`,
    '这是一次性写作：不能提问、不能调用工具、不能操作画布。下面摘录的是工作台技能里的写作规则，原本写给能提问、能操作画布的 agent；按以下方式套用到这一个节点：',
    '- 节点上已选的模型与参数就是用户的选择，不再询问模型或版本；时长、比例、分辨率、是否生成声音以节点设置为准，提示词里的时长必须与节点设置一致。',
    '- 一个节点就是一段：不做全片规划、不分批、不输出总览、资产清单（除非模板本身要求）或任何内部账本与自检过程。',
    '- 剧情来源是连线进来的文本与画布上的剧本：只导演，不编剧。源剧情超出本节点时长时，只写开头能自然容纳的连续节拍，在节拍边界截断，不压缩台词、不加快语速。',
    '- 参考只用给出的编号 {{ref N}}（N 是节点参考列表的序号），写明用途；不要编造编号或其他句柄形式。没有参考时省略参考绑定部分。',
    '- 用户已经写了内容时，保留其意图与主体，在此基础上完善。',
    '- 只输出提示词正文：不要解释、不要前后缀、不要用代码块包裹。',
  ]
  if (kind === 'video' && family === 'seedance-2.5') lines.push('- 目标模型是 Seedance 2.5：严格使用 A9.2 的最终格式（字段标题用英文，正文用中文）。')
  if (kind === 'video' && family === 'seedance-2.0') lines.push('- 目标模型是 Seedance 2.0：严格使用 A9.1 的模板。')
  if (kind === 'video' && family === 'h3') lines.push('- 目标模型是 MiniMax H3（Hailuo 3.0）：按节点的生成模式选格式（文生视频 T2VA、首帧 I2VA、首尾帧 FL2VA 用 Base 三字段，全参考用 Full-Reference 六字段）。')
  if (kind === 'image') lines.push('- 先判断这张图的用途：角色、场景、道具设定图用对应的资产模板；分镜或首帧图按首帧锁定与出镜规则；其他按普通图片写。')
  if (kind === 'audio') lines.push('- 先按模型判断音频类型：配音/朗读模型只输出要朗读的台词原文（必要时加简短的语气与声线说明）；音效与音乐模型写声音的内容、空间与时长。')
  if (kind === 'text') {
    lines.length = 0
    lines.push(
      '你在 VibeDev Film 影视工作台里，回答画布上一个文本节点里的请求。回答会直接写进这个文本节点，用户可以再改。',
      '这是一次性写作：不能提问、不能调用工具。按用户的请求与连线进来的素材写；涉及故事、剧本、改编时遵循下面摘录的工作台写作规则。',
      '只输出要写进节点的正文，不要解释或前后缀。',
    )
  }
  lines.push('规则优先级：PART A（剧情保真等）> 模型格式 > 题材技能 > 方法。')
  return lines.join('\n')
}

/**
 * Assemble the system prompt for one node.
 * @param roots - skill directories, the data directory's first (the user's edits win).
 */
export async function writingRules(input: { kind: WriteKind; model: string; topicText: string; roots: readonly string[] }): Promise<{ system: string; sources: string[] }> {
  const family = input.kind === 'video' ? videoFamily(input.model) : 'other'
  const picks = recipe(input.kind, family, topics(input.topicText))
  const parts = [framing(input.kind, family)]
  const sources: string[] = []
  const cache = new Map<string, string | undefined>()
  for (const pick of picks) {
    const key = `${pick.skill}/${pick.file}`
    if (!cache.has(key)) {
      let text: string | undefined
      for (const root of input.roots) {
        text = await readFile(join(root, pick.skill, pick.file), 'utf8').catch(() => undefined)
        if (text !== undefined) break
      }
      cache.set(key, text)
    }
    const text = cache.get(key)
    if (text === undefined) continue
    const sections = extractSections(text, pick.sections)
    if (sections.length === 0) continue
    sources.push(`${key}（${sections.length}/${pick.sections.length} 节）`)
    parts.push(`\n===== 摘自技能 ${pick.skill}（${pick.file}）=====${pick.note === undefined ? '' : `\n${pick.note}`}\n${sections.join('\n\n')}`)
  }
  return { system: parts.join('\n'), sources }
}
