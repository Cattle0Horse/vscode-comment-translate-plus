import { ModelRetry, RequestRetry, TranslationFailure } from "../model/diagnostics.ts"
import { referenceText } from "../documents/references.ts"
import type { ServiceSettings } from "./settings.ts"
import type { TranslationRequest, PreparedRequest, TranslationProvider } from "./providers/protocol.ts"
import type { TranslationUnit } from "./unit.ts"

export interface CompiledBatch {
  readonly payload: TranslationRequest
  readonly request: PreparedRequest
}

type PlannedBatch =
  | { readonly kind: "ready"; readonly units: readonly TranslationUnit[]; readonly reason: string; readonly compiled: CompiledBatch }
  | { readonly kind: "oversized"; readonly unit: TranslationUnit; readonly characters: number }

/** Owns the current provider's batch limits, learning, and recovery decisions. */
export class BatchPolicy {
  private readonly capacity?: { items: number; characters: number; successes: number }

  constructor(
    private readonly settings: ServiceSettings,
    private readonly provider: TranslationProvider
  ) {
    if (provider.adaptive)
      this.capacity = {
        items: Math.min(settings.initialItemsPerRequest, settings.maxItemsPerRequest),
        characters: Math.min(settings.initialRequestCharacters, settings.maxRequestCharacters),
        successes: 0
      }
  }

  compile(units: readonly TranslationUnit[], review?: ModelRetry, previousOutput?: string | readonly string[]): CompiledBatch {
    const redact = (text: string): string => (this.settings.apiKey ? text.split(this.settings.apiKey).join("[REDACTED]") : text)
    const payload: TranslationRequest = {
      settings: this.settings,
      previousOutput: typeof previousOutput === "string" ? redact(previousOutput) : previousOutput?.map(redact),
      context: referenceText(units.map((unit) => ({ source: unit.source, hasMarkers: unit.prepared!.hasMarkers }))),
      retryFeedback: units.flatMap((unit, index) => {
        const feedback = (review ?? unit.feedback)?.feedback
        return feedback ? [{ index, reason: redact(feedback.reason), instruction: redact(feedback.instruction) }] : []
      }),
      items: units.map((unit) => {
        const prepared = unit.prepared!
        return { id: unit.source.id, format: unit.source.format, kind: unit.source.kind, text: prepared.text, hasMarkers: prepared.hasMarkers }
      })
    }
    return { payload, request: this.provider.prepare(payload) }
  }

  fits(batch: CompiledBatch): boolean {
    return batch.request.characters <= this.settings.maxRequestCharacters && batch.request.referenceCharacters <= this.settings.maxContextCharacters
  }

  oversized(characters: number): TranslationFailure {
    return new TranslationFailure("service-request-too-large", false, {
      reason: "完整单元、提示词与重试指引超出请求预算，未截断发送。",
      expected: String(this.settings.maxRequestCharacters),
      actual: String(characters)
    })
  }

  plan(candidates: readonly TranslationUnit[]): PlannedBatch {
    const maximum = Math.min(this.settings.maxItemsPerRequest, this.capacity?.items ?? this.settings.maxItemsPerRequest)
    let compiled: CompiledBatch | undefined
    let size = 0
    let reason = "待译项已选完"
    while (size < candidates.length) {
      if (size >= maximum) {
        reason = "达到项数目标"
        break
      }
      if (size && this.settings.batchBySemanticScope && candidates[size].source.scope !== candidates[0].source.scope) {
        reason = "语义范围变化"
        break
      }
      const candidate = this.compile(candidates.slice(0, size + 1))
      if (!this.fits(candidate)) {
        reason = candidate.request.referenceCharacters > this.settings.maxContextCharacters ? "达到参考预算" : "达到请求字符上限"
        if (!size) return { kind: "oversized", unit: candidates[0], characters: candidate.request.characters }
        break
      }
      if (size && this.capacity && candidate.request.characters > this.capacity.characters) {
        reason = "达到请求字符目标"
        break
      }
      compiled = candidate
      size++
    }
    return { kind: "ready", units: candidates.slice(0, size), reason, compiled: compiled! }
  }

  succeeded(count: number, reason: string): void {
    const capacity = this.capacity
    if (!capacity || !this.settings.adaptiveBatching || (count < Math.min(capacity.items, this.settings.maxItemsPerRequest) && reason !== "达到请求字符目标")) return
    if (++capacity.successes < this.settings.batchGrowthSuccesses) return
    capacity.items = Math.min(this.settings.maxItemsPerRequest, capacity.items + this.settings.batchGrowthItems)
    capacity.characters = Math.min(this.settings.maxRequestCharacters, Math.ceil(capacity.characters * this.settings.batchGrowthFactor))
    capacity.successes = 0
  }

  recover(failed: readonly TranslationUnit[], attemptedCount: number): { readonly units: readonly TranslationUnit[]; readonly size: number } | undefined {
    const terminal = failed.find((unit) => !(unit.failure instanceof ModelRetry) && !(unit.failure instanceof RequestRetry))
    const modelRetry = failed.some((unit) => unit.failure instanceof ModelRetry)
    if (terminal || (!this.capacity && modelRetry)) throw terminal?.failure ?? failed[0].failure
    if (attemptedCount > 1 && this.capacity && this.settings.adaptiveBatching && failed.some((unit) => unit.failure instanceof ModelRetry && !unit.failure.advisory)) {
      this.capacity.items = Math.max(1, Math.floor(Math.min(this.capacity.items, attemptedCount) * this.settings.batchShrinkFactor))
      this.capacity.characters = Math.max(256, Math.floor(this.capacity.characters * this.settings.batchShrinkFactor))
      this.capacity.successes = 0
    }
    const units = failed.filter((unit) => unit.canRetry)
    if (!units.length) return
    let size = units.length
    if (modelRetry && this.capacity)
      size = units.some((unit) => unit.attempts >= this.settings.maxTranslationAttempts - 1)
        ? 1
        : Math.max(1, Math.min(this.capacity.items, Math.ceil(units.length * this.settings.batchShrinkFactor)))
    return { units, size }
  }
}
