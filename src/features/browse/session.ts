import type { TranslationInput } from "../../model/translation.ts"
import type { TranslationItem } from "../../model/translation.ts"
import type { ParsedDocument, TextUnit } from "../../model/document.ts"
import type { CancellationReason } from "../../model/diagnostics.ts"

export interface VisibleRange {
  readonly start: number
  readonly end: number
}

export interface TranslatedUnit extends TextUnit {
  readonly translation: string
}

export interface BrowseSnapshot {
  readonly scope: "document" | "blocks"
  readonly version: number
  readonly status: "working" | "ready" | "cancelled" | "error"
  readonly pending: number
  readonly total: number
  readonly failedUnits: readonly { readonly unit: TextUnit; readonly code: string }[]
  readonly loading: readonly TextUnit[]
  readonly units: readonly TranslatedUnit[]
  readonly errors: readonly string[]
}

export type Translate = (
  input: TranslationInput,
  signal: AbortSignal,
  force?: boolean,
  completed?: (item: TranslationItem) => void,
  interests?: ReadonlyMap<string, AbortSignal>
) => Promise<ReadonlyMap<string, string>>

interface BrowseRequest {
  readonly controller: AbortController
  readonly units: Map<string, { readonly unit: TextUnit; readonly controller: AbortController }>
}

export class BrowseSession {
  private readonly inflight = new Set<BrowseRequest>()
  private units: readonly TextUnit[] = []
  private planningErrors: readonly string[] = []
  private readonly failures = new Map<string, string>()
  private readonly translations = new Map<string, TranslatedUnit>()
  private readonly selected = new Set<string>()
  private paused = false
  private ranges: readonly VisibleRange[] = []
  private version = 0

  constructor(
    private readonly translate: Translate,
    private readonly changed: () => void,
    private readonly failed?: (error: unknown) => void,
    private scope: BrowseSnapshot["scope"] = "document"
  ) {}

  update(document: ParsedDocument, version: number): void {
    this.invalidate(version)
    this.units = document.groups.flatMap((group) => group.units)
    this.planningErrors = document.errors
    for (const code of document.errors) this.failed?.(Error(code))
    this.changed()
  }

  invalidate(version: number): void {
    this.stopRequests("document-changed")
    this.version = version
    this.translations.clear()
    this.failures.clear()
    this.selected.clear()
    this.units = []
    this.planningErrors = []
    this.changed()
  }

  setVisibleRanges(ranges: readonly VisibleRange[], force = false): void {
    this.ranges = ranges
    if (this.paused) return
    const selected = this.units.filter(
      (unit) =>
        (this.scope === "document" || this.selected.has(unit.id)) &&
        !this.translations.has(unit.id) &&
        !this.failures.has(unit.id) &&
        ranges.some((range) => unit.start <= range.end && unit.end >= range.start)
    )
    const pending = new Set([...this.inflight].flatMap((request) => [...request.units.keys()]))
    const units = selected.filter((unit) => !pending.has(unit.id))
    this.request(units, force)
  }

  retranslate(range: VisibleRange): boolean {
    const units = this.units.filter((unit) => {
      const display = unit.display ?? unit
      return range.start === range.end ? display.start <= range.start && range.start < display.end : display.start < range.end && range.start < display.end
    })
    if (!units.length) return false
    this.paused = false
    for (const unit of units) {
      if (this.scope === "blocks") this.selected.add(unit.id)
      this.translations.delete(unit.id)
      this.failures.delete(unit.id)
      for (const request of this.inflight) {
        const pending = request.units.get(unit.id)
        request.units.delete(unit.id)
        pending?.controller.abort("retranslation")
        if (!request.units.size) {
          this.inflight.delete(request)
          request.controller.abort("retranslation")
        }
      }
    }
    this.request(units, true)
    return true
  }

  private request(units: readonly TextUnit[], force: boolean): void {
    if (!units.length) return
    const input: TranslationInput = { units }
    const controller = new AbortController()
    const signal = controller.signal
    const request: BrowseRequest = { controller, units: new Map(units.map((unit) => [unit.id, { unit, controller: new AbortController() }])) }
    this.inflight.add(request)
    const accept = (item: TranslationItem): void => {
      if (signal.aborted || !this.inflight.has(request) || this.translations.has(item.id)) return
      const unit = request.units.get(item.id)?.unit
      if (!unit) return
      this.translations.set(unit.id, { ...unit, translation: item.text })
      this.changed()
    }
    void this.translate(input, signal, force, accept, new Map([...request.units].map(([id, pending]) => [id, pending.controller.signal])))
      .then((result) => {
        signal.throwIfAborted()
        for (const { unit } of request.units.values()) {
          const text = result.get(unit.id)
          if (text === undefined) throw Error("translation-items-mismatch")
          accept({ id: unit.id, text })
        }
      })
      .catch((error) => {
        if (signal.aborted) return
        const code = error instanceof Error && /^(?:(?:service|translation)-[a-z0-9-]+|prompt-template-invalid)$/.test(error.message) ? error.message : "translation-failed"
        const missing = [...request.units.values()].filter(({ unit }) => !this.translations.has(unit.id))
        for (const { unit } of missing) this.failures.set(unit.id, code)
        if (missing.length) this.failed?.(error)
      })
      .finally(() => {
        if (this.inflight.delete(request)) this.changed()
      })
    this.changed()
  }

  enableBrowse(): void {
    this.scope = "document"
    this.selected.clear()
    this.restart()
  }

  restart(force = false): void {
    this.paused = false
    this.failures.clear()
    if (force) {
      this.stopRequests("retranslation")
      this.translations.clear()
    }
    this.setVisibleRanges(this.ranges, force)
    this.changed()
  }

  cancel(reason: CancellationReason = "user-cancelled"): void {
    this.stopRequests(reason)
    this.paused = true
    this.translations.clear()
    this.changed()
  }

  inspect(): BrowseSnapshot {
    const loading = [...this.inflight].flatMap((request) => [...request.units.values()].map(({ unit }) => unit).filter((unit) => !this.translations.has(unit.id)))
    const errors = [...this.planningErrors, ...new Set(this.failures.values())]
    return {
      scope: this.scope,
      version: this.version,
      status: this.paused ? "cancelled" : this.inflight.size ? "working" : errors.length ? "error" : "ready",
      pending: this.inflight.size,
      total: this.scope === "document" ? this.units.length : this.selected.size,
      failedUnits: this.units.filter((unit) => this.failures.has(unit.id)).map((unit) => ({ unit, code: this.failures.get(unit.id)! })),
      loading,
      units: [...this.translations.values()].sort((a, b) => a.start - b.start),
      errors
    }
  }

  dispose(reason: CancellationReason = "extension-disposed"): void {
    this.cancel(reason)
    this.units = []
  }

  private stopRequests(reason: CancellationReason): void {
    for (const request of this.inflight) request.controller.abort(reason)
    this.inflight.clear()
  }
}
