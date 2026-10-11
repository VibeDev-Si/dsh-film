/**
 * Capability-driven options for a generation node.
 *
 * The gateway does not hand out generic models: each one declares, per mode, which
 * inputs it accepts and which durations and resolutions it offers. The workbench
 * must offer exactly those, move a node's existing choice into the allowed range
 * when the model changes, and refuse a request the model cannot serve — never send
 * one and let the far end fail. This is the strategy the previous canvas used
 * (`video-modes`, `normalize-for-model`, `reference-refusal`), kept in one place
 * so the node panel, the bridge and the session's tools all agree.
 */

/** What one mode accepts: each input slot's allowed count. */
export interface ModeConstraint {
  readonly inputs: Readonly<Record<string, { readonly min: number; readonly max: number }>>
  readonly durations?: readonly number[]
  readonly resolutions?: readonly string[]
}

/** A media model's declared capabilities, as the gateway catalogue states them. */
export interface ModelCapabilities {
  readonly modes?: Readonly<Record<string, ModeConstraint>>
  readonly durations?: readonly number[]
  readonly resolutions?: readonly string[]
  /** Set when the catalogue could not be read for this model: nothing may be offered. */
  readonly unreadableModesVersion?: number
}

/** What a node currently has chosen. */
export interface RequestedOptions {
  readonly mode?: string
  readonly duration?: number
  readonly resolution?: string
  /** How many references of each kind are wired in. */
  readonly references?: { readonly image?: number; readonly video?: number; readonly audio?: number }
}

export interface NormalizedOptions {
  readonly mode?: string
  readonly duration?: number
  readonly resolution?: string
  /** Every value this function had to move, in the user's language. */
  readonly changes: readonly string[]
}

export interface OptionCheck {
  readonly options: NormalizedOptions
  /** What the model cannot serve; a non-empty list must block submission. */
  readonly problems: readonly string[]
}

/** The duration a model offers nearest to what was asked (ties go to the shorter one). */
function nearest(value: number, offered: readonly number[]): number | undefined {
  let best: number | undefined
  for (const candidate of offered) {
    if (best === undefined || Math.abs(candidate - value) < Math.abs(best - value)) best = candidate
  }
  return best
}

/**
 * Fit a node's choice to what its model offers, and report what it cannot serve.
 * @param capabilities - the model's declaration.
 * @param requested - what the node has now.
 * @returns the options to use, what moved, and what blocks submission.
 */
export function fitToModel(capabilities: ModelCapabilities, requested: RequestedOptions): OptionCheck {
  if (capabilities.unreadableModesVersion !== undefined) {
    return { options: { changes: [] }, problems: ['这个模型的能力目录读不出来，不能生成；请换一个模型'] }
  }
  const modes = capabilities.modes
  if (modes === undefined || Object.keys(modes).length === 0) {
    // No per-mode declaration: the flat lists are all that is known.
    return fitFlat(capabilities, requested)
  }
  const mode = requested.mode !== undefined && modes[requested.mode] !== undefined ? requested.mode
    : requested.mode === undefined ? undefined : Object.keys(modes)[0]
  if (mode === undefined) return { options: { changes: [] }, problems: ['这个模型没有可用的生成模式'] }
  const changes: string[] = []
  if (requested.mode !== undefined && mode !== requested.mode) changes.push(`生成模式已改为「${mode}」`)
  const constraint = modes[mode]!
  const durations = constraint.durations ?? capabilities.durations ?? []
  const resolutions = constraint.resolutions ?? capabilities.resolutions ?? []
  const duration = fitDuration(requested.duration, durations, changes)
  const resolution = fitResolution(requested.resolution, resolutions, changes)
  const problems = referenceProblems(constraint, requested.references)
  return {
    options: {
      mode,
      ...duration === undefined ? {} : { duration },
      ...resolution === undefined ? {} : { resolution },
      changes,
    },
    problems,
  }
}

/** The model declares no modes: fit against its flat duration and resolution lists. */
function fitFlat(capabilities: ModelCapabilities, requested: RequestedOptions): OptionCheck {
  const changes: string[] = []
  const duration = fitDuration(requested.duration, capabilities.durations ?? [], changes)
  const resolution = fitResolution(requested.resolution, capabilities.resolutions ?? [], changes)
  const problems = requested.mode === undefined ? [] : ['这个模型没有声明生成模式，不能按所选模式生成']
  return {
    options: {
      ...requested.mode === undefined ? {} : { mode: requested.mode },
      ...duration === undefined ? {} : { duration },
      ...resolution === undefined ? {} : { resolution },
      changes,
    },
    problems,
  }
}

function fitDuration(requested: number | undefined, offered: readonly number[], changes: string[]): number | undefined {
  if (offered.length === 0) return undefined
  if (requested !== undefined && offered.includes(requested)) return requested
  const chosen = requested === undefined ? offered[0]! : nearest(requested, offered)!
  if (requested !== undefined && chosen !== requested) changes.push(`时长已改为 ${chosen} 秒（模型支持 ${offered.join('/')} 秒）`)
  return chosen
}

function fitResolution(requested: string | undefined, offered: readonly string[], changes: string[]): string | undefined {
  if (offered.length === 0) return undefined
  if (requested !== undefined && offered.includes(requested)) return requested
  const chosen = offered[0]!
  if (requested !== undefined && chosen !== requested) changes.push(`清晰度已改为 ${chosen}（模型支持 ${offered.join('/')}）`)
  return chosen
}

/** What the chosen mode's input slots allow, against what the node has wired in. */
function referenceProblems(constraint: ModeConstraint, references: RequestedOptions['references']): string[] {
  if (references === undefined) return []
  // The catalogue names a slot `referenceImages` (or, for frames, `firstFrame`);
  // accept the short spellings too so a differently-worded declaration still works.
  const slots = {
    // A frame slot holds one image too: `first_last_frame` takes `firstFrame`/`lastFrame`.
    image: ['referenceImages', 'images', 'image', 'firstFrame', 'lastFrame'],
    video: ['referenceVideos', 'videos', 'video'],
    audio: ['referenceAudios', 'audios', 'audio'],
  } as const
  const labels: Record<keyof typeof slots, string> = { image: '参考图', video: '参考视频', audio: '参考音频' }
  const problems: string[] = []
  for (const kind of Object.keys(slots) as (keyof typeof slots)[]) {
    const count = references[kind] ?? 0
    if (count === 0) continue
    const label = labels[kind]
    const slot = slots[kind].map(name => constraint.inputs[name]).find(item => item !== undefined)
    if (slot === undefined) { problems.push(`${label}：这个模式不接受${label}`); continue }
    if (count > slot.max) problems.push(`${label}最多 ${slot.max} 个，当前连了 ${count} 个`)
    if (count < slot.min) problems.push(`${label}至少需要 ${slot.min} 个，当前连了 ${count} 个`)
  }
  return problems
}
