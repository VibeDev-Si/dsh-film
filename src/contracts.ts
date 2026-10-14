export interface TextModel {
  id: string; name: string; api: 'anthropic-messages' | 'openai-responses' | 'openai-completions'
  contextWindow: number; maxTokens: number
}
export interface MediaModel {
  id: string; name: string; kind: string; inputModalities: readonly string[]
  video?: { modes?: Record<string, { inputs: Record<string, { min: number; max: number }>; durations?: number[]; resolutions?: string[] }>
    unreadableModesVersion?: number; durations?: number[]; resolutions?: string[]; ratios?: string[]; nativeAudio?: boolean
    textToVideo?: boolean; firstFrame?: boolean; lastFrame?: boolean; imageToVideo?: boolean
    maxReferenceImages?: number; maxReferenceVideos?: number; maxReferenceAudios?: number }
  /** Conditional video Token price (account plugin; passed through unchanged). Quote it with `videoQuote`, never as a per-second price. */
  videoPricing?: VideoTokenPricing
  /** Set instead of `videoPricing` when the catalog has one this account plugin cannot use; never falls back to legacy pricing. */
  videoPricingIssue?: 'unknown-schema' | 'invalid'
}
export interface VideoTokenRule {
  resolution: string
  /** Absent = any; `false` = none allowed; `true` = at least one. First/last frames count as image references. */
  referenceVideo?: boolean; referenceAudio?: boolean; referenceImage?: boolean
  pricePerMillionTokensCny: number
  /** Absent = unknown, not zero. */
  estimatedPricePerSecondCny?: number
}
export interface VideoTokenPricing {
  schemaVersion: 1; currency: 'CNY'; finalBasis: 'provider_tokens'; estimateBasis: 'output_plus_reference_video_seconds'
  estimateOnly: boolean; rules: readonly VideoTokenRule[]
}
/** What a video would cost, asked before anything is uploaded or submitted. */
export interface VideoQuoteRequest {
  model: string; resolution?: string; durationSeconds?: number
  /** One entry per reference video (no `durationSeconds` = unknown); `images` counts first/last frames; `generateAudio` is not an audio reference. */
  references?: { videos?: readonly { durationSeconds?: number }[]; images?: number; audios?: number }
}
type Bilingual = { en: string; zh: string }
export type VideoQuote =
  | { status: 'estimate'; mode: 'video_token'; model: string; currency: 'CNY'; amountCny: string
      estimatedPricePerSecondCny: number; pricePerMillionTokensCny: number
      outputSeconds: number; referenceVideoSeconds: number; billedSeconds: number
      rule: { resolution: string; referenceVideo?: boolean; referenceAudio?: boolean; referenceImage?: boolean }
      estimateOnly: true; finalBasis: 'provider_tokens'; label: Bilingual; basis: Bilingual }
  | { status: 'estimate'; mode: 'legacy'; model: string; currency: 'CNY'; amountCny: string; label: Bilingual; basis: Bilingual }
  | { status: 'unavailable'; mode: 'video_token' | 'legacy' | 'none'; model: string
      reason: 'no-price' | 'unknown-schema' | 'invalid-pricing' | 'no-matching-rule' | 'ambiguous-rules'
        | 'missing-resolution' | 'missing-duration' | 'unknown-reference-duration' | 'no-estimated-price' | 'invalid-request'
      pricePerMillionTokensCny?: number; label: Bilingual; basis: Bilingual }
export interface Catalog { text: readonly TextModel[]; media: readonly MediaModel[] }
export interface GatewayService {
  version: number
  models(signal?: AbortSignal): Promise<Catalog>
  text(path: string, body: Record<string, unknown>, signal: AbortSignal, sessionId?: string): Promise<Response>
}
export interface TaskOutput {
  path?: string; url?: string; contentType?: string; title?: string
  /** Playback length. */
  durationSeconds?: number
  /** The original length a speech output is billed on, when it differs from playback. */
  originalSeconds?: number
}
export interface Task {
  id: string; status: string; outputs?: readonly TaskOutput[]
  error?: { code: string; message: string }
  kind?: string; audioKind?: string
  estimatedCny?: string; chargedCny?: string
  /** `pending`: the result is saved and never generated again; only the charge is still settling. */
  settlement?: 'pending' | 'settled'
  /** The gateway's reason while the charge is pending. */
  settlementPendingReason?: string
  /** How the charge was measured; `tokens` = billed video Tokens. */
  billing?: { unit?: string; unitPriceCny?: number; originalSeconds?: number; minutes?: number; tokens?: number }
}
export interface Target { cwd: string; folder: string; stem: string }

/** A price as the account plugin quotes it, in both languages: `¥0.50/次`, `¥0.015/原始秒`, `¥0.30/分钟`, `未定价`. */
export interface AudioQuote {
  priced: boolean; unit?: string; unitPriceCny?: number; amountCny?: number
  label: { en: string; zh: string }; basis: { en: string; zh: string }
}

/** One field of an audio form: only what the model declares. */
export interface AudioFormField {
  key: 'prompt' | 'lyrics' | 'genre' | 'mood' | 'gender' | 'sourceUrl' | 'references' | 'format' | 'sampleRate' | 'watermark'
  wire: string; required: boolean
  choices?: readonly string[]
  sampleRates?: Readonly<Record<string, readonly number[]>>
  limits?: { min: number; max: number; maxBytes?: number; minSeconds?: number; maxSeconds?: number; maxTotalSeconds?: number; mimes?: readonly string[]; exclusiveWith?: readonly string[] }
  maxChars?: number
}

/** The form of one audio model, as the account plugin describes it from the catalog. */
export interface AudioForm {
  model: string; name: string; kind: 'music' | 'podcast' | 'speech'
  fields: readonly AudioFormField[]; price: AudioQuote; defaultFormat?: string
}

/** One audio generation. Unset fields are not sent; the account plugin checks each against the model. */
export interface AudioRequest {
  kind?: 'music' | 'podcast' | 'speech'; model?: string; prompt?: string
  lyrics?: string; genre?: string; mood?: string; gender?: string; sourceUrl?: string
  references?: readonly string[]; format?: string; sampleRate?: number; watermark?: boolean
  /** One user operation: the same key returns the task recorded under it and never submits again. */
  operationId?: string
}

export interface MediaService {
  /**
   * The image and video models the account can use. The released account plugin
   * already exposes this, which is what lets the workbench open — and generate
   * images and videos — before the Film text interface exists.
   */
  models(signal?: AbortSignal): Promise<readonly MediaModel[]>
  generateImages(request: { model?: string; prompt: string; size?: string; n?: number; references?: readonly string[] }, target: Target, signal: AbortSignal): Promise<{ images: readonly { absolutePath: string; mediaType: string }[] }>
  startVideo(request: { model?: string; prompt: string; duration?: number; aspectRatio?: string; resolution?: string; mode?: string; generateAudio?: boolean; firstFrame?: string; lastFrame?: string; referenceImages?: readonly string[]; referenceVideos?: readonly string[]; referenceAudios?: readonly string[] }, target: Target, signal: AbortSignal): Promise<Task>
  task(id: string): Promise<Task | undefined>
  /** Audio (account plugin 0.3.1 and later); absent on older plugins, which offer no audio models then. */
  audioForms?(signal?: AbortSignal): Promise<readonly AudioForm[]>
  startAudio?(request: AudioRequest, target: Target, signal: AbortSignal): Promise<Task>
  /** The files of a finished task, renewing links and downloading again what is missing — a query, never a new generation. */
  result?(id: string, signal?: AbortSignal): Promise<readonly TaskOutput[] | undefined>
  /** A video price estimate from the cached catalog: no upload, no task, no side effects. Absent on older account plugins. */
  videoQuote?(request: VideoQuoteRequest, signal?: AbortSignal): Promise<VideoQuote>
}
