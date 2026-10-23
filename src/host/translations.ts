import * as vscode from "vscode"
import { getTranslationSettings } from "./configuration.ts"
import type { TranslationSettings } from "./configuration.ts"
import { RequestGate } from "../translation/requestGate.ts"
import { prepareInput } from "../translation/prepare.ts"
import { TranslationService } from "../translation/engine.ts"
import type { TranslationEvent } from "../model/events.ts"
import { TranslationLog } from "./logging.ts"
import { TranslationStore } from "../translation/store.ts"
import type { ParsedDocument } from "../model/document.ts"
import type { SourceEdit } from "../documents/edits.ts"
import type { PreparedInput, TranslationInput } from "../model/translation.ts"
import type { TranslationItem } from "../model/translation.ts"
import type { PreserveTerms } from "../model/translation.ts"
import { describeError, TranslationFailure } from "../model/diagnostics.ts"
import { TermFiles } from "./termFiles.ts"

export class TranslationRuntime implements vscode.Disposable {
  readonly terms: TermFiles
  private readonly gate = new RequestGate(2, 2)
  private readonly store = new TranslationStore()
  private readonly service = new TranslationService()
  private readonly output = vscode.window.createOutputChannel("注释翻译+")
  private readonly log = new TranslationLog((entry) => this.output.appendLine(entry))
  private disposed = false
  constructor(context: vscode.ExtensionContext, home?: string) {
    this.terms = new TermFiles(context, home)
    this.configureLog()
  }

  async settings(uri?: vscode.Uri): Promise<TranslationSettings> {
    while (!this.disposed) {
      const before = JSON.stringify(vscode.workspace.getConfiguration("commentTranslatePlus", uri).inspect("preserveTerms"))
      let terms: PreserveTerms
      try {
        terms = await this.terms.get(uri)
      } catch (error) {
        if (!this.disposed && before !== JSON.stringify(vscode.workspace.getConfiguration("commentTranslatePlus", uri).inspect("preserveTerms"))) continue
        throw error
      }
      if (before !== JSON.stringify(vscode.workspace.getConfiguration("commentTranslatePlus", uri).inspect("preserveTerms"))) continue
      if (this.disposed) break
      return getTranslationSettings(uri, terms)
    }
    throw Error("extension-disposed")
  }

  async translate(
    document: vscode.TextDocument,
    batch: TranslationInput,
    signal: AbortSignal,
    force = false,
    completed?: (item: TranslationItem) => void,
    settings?: TranslationSettings,
    interests?: ReadonlyMap<string, AbortSignal>
  ): Promise<ReadonlyMap<string, string>> {
    if (this.disposed) throw Error("extension-disposed")
    settings ??= await this.settings(document.uri)
    signal.throwIfAborted()
    this.gate.configure(settings.rate, settings.maxConcurrentRequests)
    const units: PreparedInput["units"][number][] = []
    let started = performance.now()
    for (let index = 0; index < batch.units.length; index += 100) {
      signal.throwIfAborted()
      units.push(...prepareInput(settings, { units: batch.units.slice(index, index + 100) }).units)
      if (performance.now() - started >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        started = performance.now()
      }
    }
    signal.throwIfAborted()
    return this.store.translate(
      settings.identity,
      { units },
      (canonical, requestSignal, accepted, interests) =>
        this.service.request(
          settings,
          canonical,
          requestSignal,
          this.gate,
          accepted,
          {
            details: this.log.detailsEnabled,
            emit: (event) => this.logTranslation(event, settings, document)
          },
          interests
        ),
      signal,
      force,
      completed,
      (event) => this.log.reused(event, vscode.workspace.asRelativePath(document.uri), settings.apiKey),
      interests
    )
  }

  async translateUnits(
    document: vscode.TextDocument,
    parsed: ParsedDocument,
    signal: AbortSignal,
    progress?: (translations: ReadonlyMap<string, string>) => void
  ): Promise<ReadonlyMap<string, string>> {
    const input = { units: parsed.groups.flatMap((group) => group.units) }
    const translations = new Map<string, string>()
    const completed = progress
      ? (item: TranslationItem) => {
          signal.throwIfAborted()
          translations.set(item.id, item.text)
          progress(translations)
        }
      : undefined
    const result = await this.translate(document, input, signal, false, completed)
    signal.throwIfAborted()
    for (const [id, text] of result) translations.set(id, text)
    progress?.(translations)
    return translations
  }

  async invalidate(document: vscode.TextDocument, parsed: ParsedDocument): Promise<void> {
    const version = document.version
    const settings = await this.settings(document.uri)
    if (document.isClosed || document.version !== version) return
    this.store.invalidate(settings.identity, [prepareInput(settings, { units: parsed.groups.flatMap((group) => group.units) })])
  }

  async retainUnchanged(document: vscode.TextDocument, previous: ParsedDocument, current: ParsedDocument, edits: readonly (readonly SourceEdit[])[]): Promise<void> {
    const version = document.version
    const settings = await this.settings(document.uri)
    if (document.isClosed || document.version !== version) return
    this.store.retainUnchanged(
      settings.identity,
      prepareInput(settings, { units: previous.groups.flatMap((group) => group.units) }),
      prepareInput(settings, { units: current.groups.flatMap((group) => group.units) }),
      edits
    )
  }

  reset(): void {
    this.store.clear("configuration-changed")
    this.service.clear()
  }

  diagnose(error: unknown, uri?: vscode.Uri): string {
    const message = error instanceof Error ? error.message : ""
    const code = /^[a-z][a-z0-9-]+$/.test(message) ? message : "translation-failed"
    if (!(error instanceof TranslationFailure && error.reported))
      this.log.write("error", (uri ? vscode.workspace.asRelativePath(uri, false) + "：" : "") + describeError(code) + "（" + code + "）")
    return code
  }

  showErrors(): void {
    this.log.resetReferences()
    this.output.show(true)
  }

  configureLog(): void {
    try {
      const config = vscode.workspace.getConfiguration("commentTranslatePlus")
      this.log.configure(config.get<unknown>("logLevel", "info"), config.get<unknown>("logDetails", false))
    } catch {
      this.log.write("error", "logLevel 必须是 info、warning 或 error，logDetails 必须为布尔值。")
    }
  }

  private logTranslation(event: TranslationEvent, settings: TranslationSettings, document: vscode.TextDocument): void {
    if (this.disposed) return
    const file = vscode.workspace.asRelativePath(document.uri, false)
    this.log.record(event, {
      file,
      name: settings.name,
      model: settings.model || settings.provider,
      targetLanguage: settings.targetLanguage,
      apiKey: settings.apiKey,
      position: (offset) => {
        const position = document.positionAt(offset)
        return file + ":" + (position.line + 1) + ":" + (position.character + 1)
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.terms.dispose()
    this.store.clear()
    this.service.clear()
    this.log.resetReferences()
    this.gate.dispose()
    this.output.dispose()
  }
}
