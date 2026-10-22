import type { TranslationDifference } from "./document.ts"
import type { CancellationReason } from "./diagnostics.ts"

export type ProviderTrace =
  | {
      readonly kind: "model-request"
      readonly payload: { readonly model: string; readonly stream: boolean; readonly messages: readonly { readonly role: string; readonly content: string }[] }
    }
  | { readonly kind: "model-response"; readonly payload: string }

export interface FailedTranslation {
  readonly id: string
  readonly start: number
  readonly source: string
  readonly attempts: number
  readonly code: string
  readonly difference: TranslationDifference
}

export type TranslationDetail =
  | { readonly kind: "start"; readonly total: number }
  | {
      readonly kind: "request"
      readonly requestId: string
      readonly ids: readonly string[]
      readonly attempt: number
      readonly elapsedMs: number
      readonly httpRequests: number
      readonly cancelled: boolean
      readonly cancellationReason?: CancellationReason
      readonly detailsIncluded: boolean
      readonly completed: number
      readonly failures: readonly FailedTranslation[]
      readonly nextBatchSize?: number
      readonly sourceCharacters: number
      readonly contextCharacters: number
      readonly inputCharacters: number
      readonly referenceKinds: readonly string[]
      readonly batchReason: string
      readonly modelRequest?: Extract<ProviderTrace, { kind: "model-request" }>["payload"]
      readonly modelResponse?: string
    }
  | {
      readonly kind: "finish"
      readonly status: "complete" | "partial" | "failed" | "cancelled"
      readonly total: number
      readonly completed: number
      readonly skipped: number
      readonly changed: number
      readonly unchanged: number
      readonly httpRequests: number
      readonly elapsedMs: number
      readonly failures: readonly FailedTranslation[]
      readonly code?: string
      readonly cancellationReasons?: readonly CancellationReason[]
    }

export type TranslationEvent = TranslationDetail & { readonly taskId: string }

export interface TranslationTrace {
  readonly details: boolean
  emit(event: TranslationEvent): void
}
