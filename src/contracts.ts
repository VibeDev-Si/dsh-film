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
}
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
}
