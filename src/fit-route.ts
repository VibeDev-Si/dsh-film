/**
 * The fit endpoint: the workbench asks what its node may do with the model it is
 * on, and gets back the options to use plus anything that must block submission.
 *
 * The rules live in one place (`model-options.ts`) and are reached from the node
 * panel through here, so the panel, the bridge and the session's tools cannot
 * drift apart on what a model accepts.
 */
import { z } from 'zod'
import { fitToModel, type ModelCapabilities, type RequestedOptions } from './model-options.js'

const slot = z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
const mode = z.object({
  inputs: z.record(z.string(), slot),
  durations: z.array(z.number().positive()).optional(),
  resolutions: z.array(z.string().min(1)).optional(),
})
const capabilities = z.object({
  modes: z.record(z.string(), mode).optional(),
  durations: z.array(z.number().positive()).optional(),
  resolutions: z.array(z.string().min(1)).optional(),
  unreadableModesVersion: z.number().optional(),
})
const requested = z.object({
  mode: z.string().min(1).max(120).optional(),
  duration: z.number().positive().optional(),
  resolution: z.string().min(1).max(64).optional(),
  references: z.object({
    image: z.number().int().nonnegative().optional(),
    video: z.number().int().nonnegative().optional(),
    audio: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict()

/** Unknown capability fields are allowed: the gateway catalogue may grow. */
export const fitRequestSchema = z.object({ capabilities: capabilities.passthrough(), requested }).strict()

export interface FitOutcome {
  readonly status: number
  readonly body: unknown
}

/**
 * Fit a node's choice to its model.
 * @param body - the request body (validated here).
 * @returns the options to use, what moved, and what blocks submission.
 */
export function handleFitRequest(body: unknown): FitOutcome {
  const parsed = fitRequestSchema.safeParse(body)
  if (!parsed.success) return { status: 400, body: { error: { code: 'FILM_FIT_INVALID', message: '模型能力或请求格式无效' } } }
  const check = fitToModel(parsed.data.capabilities as ModelCapabilities, parsed.data.requested as RequestedOptions)
  return { status: 200, body: { options: check.options, changes: check.options.changes, problems: check.problems, ok: check.problems.length === 0 } }
}
