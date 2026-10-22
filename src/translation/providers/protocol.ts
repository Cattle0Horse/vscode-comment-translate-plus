import type { TranslationItem, PreserveTerm } from "../../model/translation.ts"
import type { TextUnit } from "../../model/document.ts"
import type { ProviderTrace } from "../../model/events.ts"
import type { ModelFeedback } from "../../model/diagnostics.ts"

export interface ProviderSettings {
  readonly apiUrl: string
  readonly model: string
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly languageNames: Readonly<Record<string, string>>
  readonly preserveTerms: readonly PreserveTerm[]
  readonly apiKey: string
  readonly sourceLanguage: string
  readonly targetLanguage: string
}

export interface TranslationRequest {
  readonly settings: ProviderSettings
  readonly context: string
  readonly retryFeedback?: readonly (ModelFeedback & { readonly index: number })[]
  /** Exact prior response, or aligned prior items selected in the current source order. */
  readonly previousOutput?: string | readonly string[]
  readonly items: readonly (TranslationItem & Pick<TextUnit, "format" | "kind"> & { readonly hasMarkers?: boolean })[]
}

export interface HttpResponse {
  readonly text: string
  readonly url: string
  readonly cookies: string
}

export interface ProviderContext {
  readonly signal: AbortSignal
  accept(item: TranslationItem): void
  output(text: string): void
  trace(event: ProviderTrace): void
  request(url: string, init?: Omit<RequestInit, "signal">): Promise<HttpResponse>
}

export interface TranslationProvider {
  readonly id: string
  readonly defaultApiUrl: string
  readonly adaptive?: boolean
  readonly defaultPrompts?: { readonly system: string; readonly user: string }
  validate?(settings: ProviderSettings): void
  prepare(request: TranslationRequest): PreparedRequest
}

/** The measured messages and the sent messages belong to the same compiled request. */
export interface PreparedRequest {
  readonly characters: number
  readonly referenceCharacters: number
  send(context: ProviderContext): Promise<void>
}
