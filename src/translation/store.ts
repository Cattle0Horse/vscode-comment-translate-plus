import { validateTranslations } from "../translation/results.ts"
import { validateTranslation } from "../documents/validation.ts"
import { unchangedUnitRanges } from "../documents/edits.ts"
import type { SourceEdit } from "../documents/edits.ts"
import type { PreparedInput, TranslationInput } from "../model/translation.ts"
import type { TextUnit } from "../model/document.ts"
import type { CancellationReason } from "../model/diagnostics.ts"
import type { TranslationItem } from "../model/translation.ts"

interface RequestGroup {
  readonly controller: AbortController
  readonly units: Set<PendingUnit>
}

interface PendingUnit {
  readonly key: string
  readonly unit: PreparedInput["units"][number]
  readonly group: RequestGroup
  readonly interest: AbortController
  readonly consumers: Map<symbol, (text: string) => void>
  readonly promise: Promise<string>
  readonly resolve: (text: string) => void
  readonly reject: (error: unknown) => void
  value?: string
  cacheable: boolean
}

function unitContentKey(unit: TextUnit): readonly unknown[] {
  return [
    unit.format,
    unit.kind,
    unit.language,
    unit.text,
    unit.content,
    unit.yamlKey === true,
    unit.protected,
    unit.display !== undefined,
    unit.embedding ? [unitContentKey(unit.embedding.unit), unit.embedding.prefixes] : undefined
  ]
}

function unitKey(identity: string, unit: TextUnit): string {
  const references = unit.reference?.map(({ kind, text }) => ({ kind, text })) ?? []
  return JSON.stringify([identity, unitContentKey(unit), references])
}

export class TranslationStore {
  private readonly cache = new Map<string, string>()
  private readonly pending = new Map<string, PendingUnit>()
  private readonly groups = new Set<RequestGroup>()
  private size = 0

  translate(
    identity: string,
    input: TranslationInput,
    action: (input: PreparedInput, signal: AbortSignal, completed: (item: TranslationItem) => void, interests: ReadonlyMap<string, AbortSignal>) => Promise<readonly TranslationItem[]>,
    signal: AbortSignal,
    force = false,
    completed?: (item: TranslationItem) => void,
    reused?: (event: { readonly kind: "cache" | "pending"; readonly count: number; readonly total: number }) => void,
    interests?: ReadonlyMap<string, AbortSignal>
  ): Promise<ReadonlyMap<string, string>> {
    signal.throwIfAborted()
    if (force) this.invalidate(identity, [{ units: input.units.filter((unit) => !interests?.get(unit.id)?.aborted) }])
    const values = new Map<string, string>()
    const waiting = new Map<PendingUnit, TextUnit[]>()
    const created: RequestGroup = { controller: new AbortController(), units: new Set() }
    let cached = 0
    let shared = 0
    for (const [index, unit] of input.units.entries()) {
      if (interests?.get(unit.id)?.aborted) continue
      const key = unitKey(identity, unit)
      const value = this.cache.get(key)
      if (value !== undefined) {
        this.cache.delete(key)
        this.cache.set(key, value)
        values.set(unit.id, value)
        completed?.({ id: unit.id, text: value })
        cached++
        continue
      }
      let task = this.pending.get(key)
      if (task?.group.controller.signal.aborted || task?.cacheable === false) task = undefined
      if (!task) {
        let resolve!: (text: string) => void
        let reject!: (error: unknown) => void
        const promise = new Promise<string>((accept, fail) => {
          resolve = accept
          reject = fail
        })
        task = {
          key,
          unit: { ...unit, reference: unit.reference ?? [], id: "t" + index },
          group: created,
          interest: new AbortController(),
          consumers: new Map(),
          promise,
          resolve,
          reject,
          cacheable: true
        }
        created.units.add(task)
        this.pending.set(key, task)
      } else shared++
      const targets = waiting.get(task) ?? []
      targets.push(unit)
      waiting.set(task, targets)
    }
    if (cached) reused?.({ kind: "cache", count: cached, total: input.units.length })
    if (shared) reused?.({ kind: "pending", count: shared, total: input.units.length })
    const consumer = Symbol()
    for (const [task, targets] of waiting)
      task.consumers.set(consumer, (text) => {
        if (signal.aborted) return
        for (const unit of targets) {
          values.set(unit.id, text)
          completed?.({ id: unit.id, text })
        }
      })
    if (created.units.size) {
      this.groups.add(created)
      const units = [...created.units]
      const missing: PreparedInput = { units: units.map((task) => task.unit) }
      const byId = new Map(units.map((task) => [task.unit.id, task]))
      const accept = (item: TranslationItem): void => {
        created.controller.signal.throwIfAborted()
        const task = byId.get(item.id)
        if (task?.interest.signal.aborted) return
        if (!task || validateTranslation(task.unit, item.text) !== undefined) throw Error("translation-structure-invalid")
        if (task.value !== undefined) return
        if (task.cacheable) this.remember(task.key, item.text)
        for (const notify of task.consumers.values()) notify(item.text)
        task.value = item.text
        task.resolve(item.text)
      }
      void Promise.resolve()
        .then(() => action(missing, created.controller.signal, accept, new Map(units.map((task) => [task.unit.id, task.interest.signal]))))
        .then((content) => {
          created.controller.signal.throwIfAborted()
          if (units.every((task) => task.value !== undefined || task.interest.signal.aborted)) return
          for (const [id, text] of validateTranslations(missing, content)) accept({ id, text })
        })
        .catch((error) => {
          for (const task of units) if (task.value === undefined) task.reject(error)
        })
        .finally(() => {
          this.groups.delete(created)
          for (const task of units) if (this.pending.get(task.key) === task) this.pending.delete(task.key)
        })
    }
    if (!waiting.size) return Promise.resolve(values)
    return new Promise((resolve, reject) => {
      const subscriptions: (() => void)[] = []
      const releaseTask = (task: PendingUnit, reason: unknown): void => {
        task.consumers.delete(consumer)
        if (!task.consumers.size && task.value === undefined) {
          task.cacheable = false
          task.interest.abort(reason)
          task.reject(task.interest.signal.reason)
        }
      }
      const abortUnusedGroup = (group: RequestGroup, reason: unknown): void => {
        if ([...group.units].every((unit) => !unit.consumers.size) && [...group.units].some((unit) => unit.value === undefined)) group.controller.abort(reason)
      }
      const release = (): void => {
        signal.removeEventListener("abort", cancel)
        for (const unsubscribe of subscriptions) unsubscribe()
        const reason: unknown = signal.aborted ? signal.reason : "consumer-released"
        const groups = new Set<RequestGroup>()
        for (const task of waiting.keys()) {
          releaseTask(task, reason)
          groups.add(task.group)
        }
        for (const group of groups) abortUnusedGroup(group, reason)
      }
      const cancel = (): void => {
        release()
        reject(signal.reason)
      }
      signal.addEventListener("abort", cancel, { once: true })
      const promises = [...waiting].map(([task, targets]) => {
        if (!interests) return task.promise
        let detach!: () => void
        const detached = new Promise<undefined>((resolve) => {
          detach = () => resolve(undefined)
        })
        for (const target of targets.slice()) {
          const interest = interests.get(target.id)
          if (!interest) continue
          const cancelTarget = (): void => {
            const index = targets.indexOf(target)
            if (index < 0) return
            targets.splice(index, 1)
            if (!targets.length) {
              detach()
              releaseTask(task, interest.reason)
              abortUnusedGroup(task.group, interest.reason)
            }
          }
          interest.addEventListener("abort", cancelTarget, { once: true })
          subscriptions.push(() => interest.removeEventListener("abort", cancelTarget))
          if (interest.aborted) cancelTarget()
        }
        return Promise.race([detached, task.promise])
      })
      void Promise.all(promises).then(
        (texts) => {
          if (signal.aborted) return
          let index = 0
          for (const targets of waiting.values()) {
            const text = texts[index]
            if (text !== undefined) for (const unit of targets) values.set(unit.id, text)
            index++
          }
          release()
          resolve(values)
        },
        (error) => {
          release()
          reject(error)
        }
      )
      if (signal.aborted) cancel()
    })
  }

  clear(reason: CancellationReason = "extension-disposed"): void {
    for (const group of this.groups) {
      for (const task of group.units) task.cacheable = false
      group.controller.abort(reason)
    }
    this.groups.clear()
    this.pending.clear()
    this.cache.clear()
    this.size = 0
  }

  invalidate(identity: string, inputs: readonly TranslationInput[]): void {
    for (const input of inputs)
      for (const unit of input.units) {
        const key = unitKey(identity, unit)
        this.remove(key)
        const task = this.pending.get(key)
        if (task) task.cacheable = false
      }
  }

  retainUnchanged(identity: string, previous: PreparedInput, current: PreparedInput, edits: readonly (readonly SourceEdit[])[]): void {
    const unchanged = unchangedUnitRanges(previous.units, edits)
    for (const unit of current.units) {
      const before = unchanged.get(unit.start + ":" + unit.end)
      if (!before || JSON.stringify(unitContentKey(before)) !== JSON.stringify(unitContentKey(unit))) continue
      const text = this.cache.get(unitKey(identity, before))
      // Only completed, validated results survive a source edit. Pending work
      // keeps its original context and remains subject to consumer cancellation.
      if (text !== undefined) this.remember(unitKey(identity, unit), text)
    }
  }

  private remove(key: string): void {
    const previous = this.cache.get(key)
    if (previous !== undefined) this.size -= key.length + previous.length
    this.cache.delete(key)
  }

  private remember(key: string, text: string): void {
    const size = key.length + text.length
    if (size > 1_000_000) return
    this.remove(key)
    this.cache.set(key, text)
    this.size += size
    while (this.cache.size > 1024 || this.size > 1_000_000) this.remove(this.cache.keys().next().value!)
  }
}
