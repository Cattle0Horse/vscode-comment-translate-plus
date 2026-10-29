import { BatchPolicy } from "./planning.ts"
import type { CompiledBatch } from "./planning.ts"
import { TranslationUnit } from "./unit.ts"
import type { PreparedInput, TranslationItem } from "../model/translation.ts"
import type { RequestGate } from "./requestGate.ts"
import { ModelRetry, RequestRetry, TranslationFailure, cancellationReason, failureCode } from "../model/diagnostics.ts"
import { requestScope, retryDelay } from "./transport.ts"
import { request } from "./http.ts"
import { getProvider } from "./providers/index.ts"
import type { ProviderTrace, TranslationDetail, TranslationTrace } from "../model/events.ts"
import type { ServiceSettings } from "./settings.ts"
import { requestPolicyIdentity, validateService } from "./settings.ts"

export class TranslationService {
  private readonly policies = new Map<string, BatchPolicy>()
  private sequence = 0

  clear(): void {
    this.policies.clear()
  }

  async request(
    settings: ServiceSettings,
    batch: PreparedInput,
    signal: AbortSignal,
    gate: RequestGate,
    completed?: (item: TranslationItem) => void,
    trace?: TranslationTrace,
    interests?: ReadonlyMap<string, AbortSignal>,
    priority?: (id: string) => number
  ): Promise<readonly TranslationItem[]> {
    settings = { ...settings, sourceLanguage: settings.sourceLanguage.trim() || "auto", targetLanguage: settings.targetLanguage.trim() }
    validateService(settings)
    signal.throwIfAborted()
    gate.configureScope(requestScope(settings), settings)
    const key = requestPolicyIdentity(settings)
    const policy = settings.adaptiveBatching
      ? (this.policies.get(key) ?? new BatchPolicy(settings, getProvider(settings.provider)))
      : new BatchPolicy(settings, getProvider(settings.provider))
    if (settings.adaptiveBatching) {
      this.policies.delete(key)
      this.policies.set(key, policy)
      while (this.policies.size > 16) this.policies.delete(this.policies.keys().next().value!)
    }
    return new TranslationRun(settings, batch, signal, gate, policy, "T" + ++this.sequence, completed, trace, interests, priority).execute()
  }
}

interface PreviousResponse {
  readonly units: readonly TranslationUnit[]
  readonly text: string
  readonly items: ReadonlyMap<TranslationUnit, string>
}

class TranslationRun {
  private readonly units: readonly TranslationUnit[]
  private readonly controller = new AbortController()
  private readonly combined: AbortSignal
  private readonly started = performance.now()
  private requestSequence = 0
  private httpRequests = 0

  constructor(
    private readonly settings: ServiceSettings,
    batch: PreparedInput,
    private readonly signal: AbortSignal,
    private readonly gate: RequestGate,
    private readonly policy: BatchPolicy,
    private readonly taskId: string,
    private readonly completed?: (item: TranslationItem) => void,
    private readonly trace?: TranslationTrace,
    interests?: ReadonlyMap<string, AbortSignal>,
    private readonly priority: (id: string) => number = () => 2
  ) {
    const provider = getProvider(settings.provider)
    this.units = batch.units.map((unit) => new TranslationUnit(unit, settings, provider, interests?.get(unit.id)))
    this.combined = AbortSignal.any([signal, this.controller.signal])
  }

  private emit(event: TranslationDetail): void {
    this.trace?.emit({ ...event, taskId: this.taskId })
  }

  private finish(error?: unknown): void {
    const remaining = this.units.filter((unit) => unit.pending)
    const accepted = this.units.filter((unit) => unit.translation !== undefined)
    const skipped = accepted.filter((unit) => unit.skipped).length
    const changed = accepted.filter((unit) => unit.translation !== unit.source.text).length
    let status: Extract<TranslationDetail, { kind: "finish" }>["status"] = "complete"
    if (this.signal.aborted || this.units.some((unit) => !unit.wanted)) status = "cancelled"
    else if (remaining.length) status = accepted.length ? "partial" : "failed"
    else if (error !== undefined) status = "failed"
    this.emit({
      kind: "finish",
      status,
      total: this.units.length,
      completed: accepted.length,
      skipped,
      changed,
      unchanged: accepted.length - skipped - changed,
      httpRequests: this.httpRequests,
      elapsedMs: Math.round(performance.now() - this.started),
      failures: remaining.map((unit) => unit.diagnostic(unit.failure ?? error)),
      cancellationReasons:
        status === "cancelled"
          ? [
              ...new Set(
                this.signal.aborted ? [cancellationReason(this.signal.reason)] : this.units.filter((unit) => !unit.wanted).map((unit) => cancellationReason(unit.interest?.reason))
              )
            ]
          : undefined,
      code: error === undefined ? undefined : failureCode(error)
    })
  }

  private publish(unit: TranslationUnit, text: string, diagnosticCodes: readonly string[] = []): void {
    this.combined.throwIfAborted()
    if (!unit.pending) return
    unit.accept(text, (review) => this.policy.fits(this.policy.compile([unit], review, text)), diagnosticCodes)
    this.completed?.({ id: unit.source.id, text: unit.translation! })
  }

  private async prepare(): Promise<void> {
    const collisions = [
      ...new Set(this.units.flatMap(({ source }) => [source.text, ...source.reference.map((block) => block.text)]).flatMap((text) => text.match(/<CTP(?:\d+_)?/g) ?? []))
    ].join("\n")
    let started = performance.now()
    for (const unit of this.units) {
      if (performance.now() - started >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        started = performance.now()
      }
      this.combined.throwIfAborted()
      if (!unit.wanted) continue
      unit.prepare(collisions)
      if (unit.translation !== undefined) this.completed?.({ id: unit.source.id, text: unit.translation })
      else if (!unit.prepared!.needsTranslation) this.publish(unit, unit.prepared!.text)
    }
  }

  private async run(candidates: readonly TranslationUnit[], batchReason = "重新组批待恢复项", compiled?: CompiledBatch, previous?: PreviousResponse): Promise<void> {
    this.combined.throwIfAborted()
    const units = candidates.filter((unit) => unit.pending)
    if (!units.length) return
    const previousOutput =
      previous && units.length === previous.units.length && units.every((unit, index) => unit === previous.units[index])
        ? previous.text
        : previous && units.every((unit) => previous.items.has(unit))
          ? units.map((unit) => previous.items.get(unit)!)
          : undefined
    const batch = compiled && units.length === candidates.length ? compiled : this.policy.compile(units, undefined, previousOutput)
    const { payload, request: measurement } = batch
    if (!this.policy.fits(batch)) {
      if (units.length > 1) {
        const middle = Math.ceil(units.length / 2)
        await this.run(units.slice(0, middle), "重试消息超出预算，继续拆批", undefined, previous)
        await this.run(units.slice(middle), "重试消息超出预算，继续拆批", undefined, previous)
      } else units[0].reject(this.policy.oversized(measurement.characters))
      return
    }
    const abandoned = new AbortController()
    const signals = units.flatMap((unit) => (unit.interest ? [unit.interest] : []))
    const cancelUnused = (): void => {
      if (units.every((unit) => !unit.wanted)) abandoned.abort(signals.find((signal) => signal.aborted)?.reason)
    }
    for (const interest of signals) interest.addEventListener("abort", cancelUnused, { once: true })
    cancelUnused()
    const requestSignal = AbortSignal.any([this.combined, abandoned.signal])
    const notBefore = Math.max(0, ...units.map((unit) => (unit.failure instanceof RequestRetry ? (unit.failure.retryAt ?? 0) : 0)))
    for (const unit of units) unit.beginAttempt()
    const attempt = Math.max(...units.map((unit) => unit.attempts))
    const requestId = this.taskId + "/R" + ++this.requestSequence
    const started = performance.now()
    const targets = new Map(units.map((unit) => [unit.source.id, unit]))
    const reasons = new Map<string, unknown>()
    const diagnosticCodes =
      this.settings.provider === "openai"
        ? [
            ...new Set([
              ...units.flatMap((unit) => (unit.feedback ? [failureCode(unit.feedback)] : [])),
              ...(payload.retryFeedback?.flatMap((feedback) => (feedback.reason + "\n" + feedback.instruction).match(/\b(?:translation|service)-[a-z][a-z0-9-]+\b/g) ?? []) ?? [])
            ])
          ]
        : []
    let modelRequest: Extract<ProviderTrace, { kind: "model-request" }>["payload"] | undefined
    let modelResponse: string | undefined
    let lastOutput: string | undefined
    const outputItems = new Map<TranslationUnit, string>()
    let sent = 0
    let reason: unknown
    try {
      await measurement.send({
        signal: requestSignal,
        output: (text) => {
          lastOutput = text
        },
        trace: (event) => {
          if (!this.trace?.details) return
          if (event.kind === "model-request") modelRequest = event.payload
          else modelResponse = event.payload
        },
        accept: (item) => {
          if (!item || typeof item.id !== "string" || typeof item.text !== "string")
            throw new ModelRetry(
              { reason: "The response item was missing or invalid.", instruction: "Provide a non-empty translation for this item." },
              { code: "translation-item-invalid" }
            )
          const unit = targets.get(item.id)
          if (!unit || outputItems.has(unit))
            throw new ModelRetry(
              { reason: "The response contained an unknown or duplicate item.", instruction: "Return exactly one translation per source item, in the original order." },
              {
                code: "translation-items-mismatch"
              }
            )
          outputItems.set(unit, item.text)
          try {
            this.publish(unit, item.text, diagnosticCodes)
          } catch (error) {
            reasons.set(item.id, error)
          }
        },
        request: (url, init = {}, itemId) => {
          const priority = (): number => {
            if (itemId !== undefined) return this.priority(itemId)
            let highest = 2
            for (const unit of units) if (unit.wanted) highest = Math.min(highest, this.priority(unit.source.id))
            return highest
          }
          return request(
            this.gate,
            url,
            init,
            requestSignal,
            this.settings,
            attempt,
            notBefore,
            () => {
              sent++
              this.httpRequests++
            },
            priority
          )
        }
      })
      requestSignal.throwIfAborted()
      if (outputItems.size !== units.length)
        throw new ModelRetry(
          { reason: "The response item count does not match the source items.", instruction: "Return exactly one translation per source item, in the original order." },
          {
            code: "translation-items-mismatch",
            difference: { reason: "返回条目数量不匹配。", expected: units.length + " 项", actual: outputItems.size + " 项" }
          }
        )
      reason = reasons.values().next().value
    } catch (error) {
      reason = error instanceof SyntaxError ? Error("service-response-invalid") : error
    } finally {
      for (const interest of signals) interest.removeEventListener("abort", cancelUnused)
    }

    const failed = units.filter((unit) => unit.pending)
    if (reason instanceof RequestRetry && reason.retryAt === undefined && !requestSignal.aborted) reason.retryAt = performance.now() + retryDelay(this.settings, attempt)
    for (const unit of failed) unit.reject(reasons.get(unit.source.id) ?? reason)
    const record = (nextBatchSize?: number): void => {
      this.emit({
        kind: "request",
        requestId,
        ids: units.map((unit) => unit.source.id),
        attempt,
        elapsedMs: Math.round(performance.now() - started),
        httpRequests: sent,
        cancelled: requestSignal.aborted,
        cancellationReason: requestSignal.aborted ? cancellationReason(requestSignal.reason) : undefined,
        detailsIncluded: !!this.trace?.details,
        completed: units.filter((unit) => unit.translation !== undefined).length,
        failures: failed.map((unit) => unit.diagnostic(unit.failure, reasons.has(unit.source.id) || !reasons.size)),
        nextBatchSize,
        retryDelayMs: nextBatchSize
          ? Math.max(0, Math.ceil(Math.max(0, ...failed.map((unit) => (unit.failure instanceof RequestRetry ? (unit.failure.retryAt ?? 0) : 0))) - performance.now()))
          : undefined,
        sourceCharacters: payload.items.reduce((sum, item) => sum + item.text.length, 0),
        contextCharacters: measurement.referenceCharacters,
        inputCharacters: measurement.characters,
        referenceKinds: measurement.referenceCharacters ? [...new Set(units.flatMap((unit) => unit.source.reference.map((block) => block.kind)))] : [],
        batchReason,
        modelRequest,
        modelResponse
      })
      modelRequest = undefined
      modelResponse = undefined
    }
    if (this.combined.aborted) {
      record()
      this.combined.throwIfAborted()
    }
    if (abandoned.signal.aborted) {
      record()
      return
    }
    if (!failed.length) {
      record()
      this.policy.succeeded(units.length, batchReason)
      return
    }
    let recovery: ReturnType<BatchPolicy["recover"]>
    try {
      recovery = this.policy.recover(failed, units.length)
    } catch (error) {
      record()
      throw error
    }
    record(recovery?.size)
    if (recovery) {
      let response: PreviousResponse | undefined
      if (!failed.some((unit) => failureCode(unit.failure) === "translation-feedback-leaked"))
        response = lastOutput === undefined ? previous : { units, text: lastOutput, items: outputItems }
      for (let index = 0; index < recovery.units.length; index += recovery.size) {
        const next = recovery.units.slice(index, index + recovery.size)
        await this.run(next, undefined, undefined, response)
      }
    }
  }

  async execute(): Promise<readonly TranslationItem[]> {
    const active = new Set<Promise<void>>()
    let failure: { error: unknown } | undefined
    this.emit({ kind: "start", total: this.units.length })
    try {
      await this.prepare()
      const remaining = new Set(this.units.filter((unit) => unit.pending))
      const priority = (): number => {
        let highest = 2
        for (const unit of remaining) if (unit.pending) highest = Math.min(highest, this.priority(unit.source.id))
        return highest
      }
      while (remaining.size) {
        if (failure) throw failure.error
        this.combined.throwIfAborted()
        // Choose units only when the shared HTTP budget has room. A new
        // viewport can then overtake the unplanned tail of a whole document.
        await this.gate.plan(
          () => {
            let highest = 2
            let candidates: TranslationUnit[] = []
            for (const unit of remaining) {
              if (!unit.pending) continue
              const current = this.priority(unit.source.id)
              if (current < highest) {
                highest = current
                candidates = []
              }
              if (current === highest) candidates.push(unit)
            }
            if (!candidates.length) {
              remaining.clear()
              return
            }
            const batch = this.policy.plan(candidates)
            if (batch.kind === "oversized") {
              batch.unit.reject(this.policy.oversized(batch.characters))
              remaining.delete(batch.unit)
              return
            }
            for (const unit of batch.units) remaining.delete(unit)
            const work = this.run(batch.units, batch.reason, batch.compiled)
              .catch((error) => {
                failure ??= { error }
                this.controller.abort("request-failed")
              })
              .finally(() => active.delete(work))
            active.add(work)
          },
          this.combined,
          priority,
          requestScope(this.settings)
        )
      }
      await Promise.all(active)
      if (failure) throw failure.error
      this.combined.throwIfAborted()
      const unresolved = this.units.find((unit) => unit.pending && unit.failure !== undefined)
      if (unresolved) throw unresolved.failure
      this.finish()
      return this.units.filter((unit) => unit.translation !== undefined).map((unit) => ({ id: unit.source.id, text: unit.translation! }))
    } catch (error) {
      this.controller.abort("request-failed")
      await Promise.allSettled(active)
      this.finish(error)
      throw this.signal.aborted ? error : new TranslationFailure(failureCode(error), !!this.trace)
    }
  }
}
