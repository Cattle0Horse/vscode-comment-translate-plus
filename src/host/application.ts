import * as vscode from "vscode"
import { DocumentReader } from "./documents.ts"
import { TranslationRuntime } from "./translations.ts"
import { Controls } from "./controls.ts"
import { BrowseWorkspace } from "../features/browse/workspace.ts"
import { TranslationHover } from "../features/hover.ts"
import { MarkdownPreview } from "../features/preview.ts"
import { SourceReplacementAction } from "../features/replacement.ts"
import type { ParsedDocument } from "../model/document.ts"
import type { SourceEdit } from "../documents/edits.ts"
import { requestPolicySchema } from "../translation/settings.ts"
import { TranslationFailure } from "../model/diagnostics.ts"
import { addPreserveTerm } from "./addPreserveTerm.ts"

interface PendingEdit {
  readonly timer: ReturnType<typeof setTimeout>
  readonly previous: Promise<ParsedDocument | undefined> | undefined
  readonly edits: readonly (readonly SourceEdit[])[]
  retain: boolean
}

export class Application implements vscode.Disposable {
  readonly documents: DocumentReader
  readonly translations: TranslationRuntime
  readonly browse: BrowseWorkspace
  readonly hover: TranslationHover
  readonly preview: MarkdownPreview
  readonly replacement: SourceReplacementAction
  private readonly controls: Controls
  private readonly subscriptions: vscode.Disposable[]
  private readonly timers = new Map<string, PendingEdit>()
  private disposed = false
  constructor(context: vscode.ExtensionContext, home?: string) {
    this.translations = new TranslationRuntime(context, home)
    this.documents = new DocumentReader(context.extensionUri, "extension-output-" + context.extension.id + "-")
    this.browse = new BrowseWorkspace(
      context.extensionUri,
      this.documents,
      this.translations,
      () => this.controls?.render(),
      (uri, reason) => {
        const timer = this.timers.get(uri.toString())
        if (timer) clearTimeout(timer.timer)
        this.timers.delete(uri.toString())
        this.hover?.cancel(uri, reason)
        this.replacement?.cancel(uri, reason)
        if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) void vscode.commands.executeCommand("editor.action.hideHover")
      }
    )
    this.replacement = new SourceReplacementAction(this.documents, this.translations, (uri) => this.browse.inspect(uri))
    this.hover = new TranslationHover(
      this.documents,
      this.translations,
      (uri) => this.browse.inspect(uri),
      (uri) => this.timers.has(uri.toString())
    )
    this.preview = new MarkdownPreview(this.documents, this.translations, (document) => this.retranslate(document))
    this.controls = new Controls(this.documents, this.translations, this.browse, this.hover, this.preview, this.replacement, () => this.retranslate())
    const refresh = () => {
      this.browse.refreshVisible()
      this.browse.render()
      this.browse.tryAutomatic()
    }
    this.subscriptions = [
      vscode.commands.registerCommand("commentTranslatePlus.addPreserveTerm", () => addPreserveTerm(home)),
      this.translations.terms.onDidChange(() => void this.reconfigure({ affectsConfiguration: (section) => section === "commentTranslatePlus.preserveTerms" })),
      vscode.commands.registerCommand("commentTranslatePlus.refreshPreserveTerms", async () => {
        try {
          const document = vscode.window.activeTextEditor?.document
          if (document && this.documents.supports(document)) await this.translations.terms.get(document.uri)
          await this.translations.terms.refresh()
        } catch (error) {
          if (!(error instanceof TranslationFailure && error.reported)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : "无法刷新保留词文件。")
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.window.onDidChangeVisibleTextEditors(refresh),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.browse.refreshVisible()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.browse.stop(document.uri, false, "document-closed")
        this.browse.forget(document.uri)
        this.documents.invalidate(document.uri)
        this.preview.close(document.uri)
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length) this.edited(event)
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("commentTranslatePlus")) void this.reconfigure(event)
      })
    ]
    refresh()
  }

  private edited(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document
    const id = document.uri.toString()
    const pending = this.timers.get(id)
    const parsed = this.documents.invalidate(document.uri)
    const previous = pending ? pending.previous : parsed
    const edits = [...(pending?.edits ?? []), event.contentChanges]
    this.hover.cancel(document.uri, "document-changed")
    this.replacement.cancel(document.uri, "document-changed")
    if (this.preview.has(document.uri)) this.preview.cancel(document.uri, "document-changed", "源文已变化，正在等待刷新。")
    this.browse.invalidate(document)
    if (pending) clearTimeout(pending.timer)
    this.timers.delete(id)
    if (!this.browse.has(document.uri) && !this.preview.has(document.uri)) return
    const configuredDelay = vscode.workspace.getConfiguration("commentTranslatePlus", document.uri).get<unknown>("editDebounceMs", 1000)
    const delay = typeof configuredDelay === "number" && Number.isInteger(configuredDelay) && configuredDelay >= 0 && configuredDelay <= 60000 ? configuredDelay : 1000
    const update: PendingEdit = { timer: setTimeout(() => void this.refreshEdited(document, update), delay), previous, edits, retain: pending?.retain ?? true }
    this.timers.set(id, update)
  }

  private async refreshEdited(document: vscode.TextDocument, pending: PendingEdit): Promise<void> {
    const id = document.uri.toString()
    const version = document.version
    const isCurrent = (): boolean => !this.disposed && !document.isClosed && document.version === version && this.timers.get(id) === pending
    try {
      const before = await pending.previous
      if (!isCurrent()) return
      if (before) {
        const current = await this.documents.parse(document, true)
        if (!isCurrent()) return
        if (pending.retain) await this.translations.retainUnchanged(document, before, current, pending.edits)
      }
    } catch {
      // Browse and preview report parse/configuration failures through their
      // existing paths; cache retention must not add a duplicate diagnostic.
    }
    if (!isCurrent()) return
    this.timers.delete(id)
    await this.browse.updateDocument(document)
    if (!this.disposed && !document.isClosed && document.version === version) this.preview.update(document.uri)
  }

  async retranslate(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document) return
    const pending = this.timers.get(document.uri.toString())
    if (pending) pending.retain = false
    const parsed = await this.documents.parse(document)
    await this.translations.invalidate(document, parsed)
    this.hover.cancel(document.uri, "retranslation")
    this.replacement.cancel(document.uri, "retranslation")
    this.browse.restart(document.uri, true)
    this.preview.update(document.uri, "retranslation")
    await vscode.commands.executeCommand("editor.action.hideHover")
  }

  private async reconfigure(event: vscode.ConfigurationChangeEvent): Promise<void> {
    if (event.affectsConfiguration("commentTranslatePlus.logLevel") || event.affectsConfiguration("commentTranslatePlus.logDetails")) this.translations.configureLog()
    if (event.affectsConfiguration("commentTranslatePlus.browse")) this.documents.clear()
    if (event.affectsConfiguration("commentTranslatePlus.profiles")) this.translations.reset()
    const processing = [
      "profiles",
      "activeProfile",
      "sourceLanguage",
      "targetLanguage",
      "preserveTerms",
      "skipSameLanguage",
      "browse",
      ...Object.keys(requestPolicySchema),
      "maxRequestsPerSecond",
      "maxConcurrentRequests"
    ].some((key) => event.affectsConfiguration("commentTranslatePlus." + key))

    if (processing || event.affectsConfiguration("commentTranslatePlus.hover"))
      for (const document of vscode.workspace.textDocuments) {
        this.hover.cancel(document.uri, "configuration-changed")
        this.replacement.cancel(document.uri, "configuration-changed")
      }
    if (processing) this.preview.update(undefined, "configuration-changed")
    if (processing || event.affectsConfiguration("commentTranslatePlus.auto")) await this.browse.reconfigure()
    this.browse.render()
  }

  dispose(): void {
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const timer of this.timers.values()) clearTimeout(timer.timer)
    this.timers.clear()
    this.controls.dispose()
    this.browse.dispose()
    this.hover.dispose()
    this.replacement.dispose()
    this.preview.dispose()
    this.documents.dispose()
    this.translations.dispose()
    void vscode.commands.executeCommand("setContext", "commentTranslatePlus.supported", false)
    void vscode.commands.executeCommand("setContext", "commentTranslatePlus.browse", false)
  }
}
