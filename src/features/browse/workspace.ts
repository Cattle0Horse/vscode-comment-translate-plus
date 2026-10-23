import * as vscode from "vscode"
import { automatic, displayMode, getTranslationSettings } from "../../host/configuration.ts"
import type { DocumentReader } from "../../host/documents.ts"
import type { TranslationRuntime } from "../../host/translations.ts"
import type { CancellationReason } from "../../model/diagnostics.ts"
import { BrowseSession } from "./session.ts"
import type { BrowseSnapshot } from "./session.ts"
import { BrowseRenderer } from "./renderer.ts"

interface DocumentSession {
  readonly document: vscode.TextDocument
  readonly session: BrowseSession
}

export class BrowseWorkspace implements vscode.Disposable {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly overrides = new Map<string, boolean>()
  private readonly renderer: BrowseRenderer
  private disposed = false
  constructor(
    extensionUri: vscode.Uri,
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime,
    private readonly changed: () => void,
    private readonly stopped: (uri: vscode.Uri, reason: CancellationReason) => void
  ) {
    this.renderer = new BrowseRenderer(extensionUri, (uri) => this.inspect(uri))
  }

  inspect(uri: vscode.Uri): BrowseSnapshot | undefined {
    return this.sessions.get(uri.toString())?.session.inspect()
  }

  has(uri: vscode.Uri): boolean {
    return this.sessions.has(uri.toString())
  }

  toggle(): Promise<void> | void {
    const document = vscode.window.activeTextEditor?.document
    if (!document) return
    if (this.inspect(document.uri)?.scope === "document") this.stop(document.uri, true)
    else return this.start(document)
  }

  cancel(uri: vscode.Uri): void {
    this.sessions.get(uri.toString())?.session.cancel()
  }

  restart(uri: vscode.Uri, force = false): void {
    this.sessions.get(uri.toString())?.session.restart(force)
  }

  async retranslateBlock(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor
    if (!editor) return false
    if (editor.selections.length !== 1) {
      void vscode.window.showWarningMessage("重新翻译当前块仅支持一个选区或光标，请先取消多光标。")
      return false
    }
    const document = editor.document
    const version = document.version
    const range = { start: document.offsetAt(editor.selection.start), end: document.offsetAt(editor.selection.end) }
    if (!this.has(document.uri)) await this.start(document, false, "blocks")
    const current = this.sessions.get(document.uri.toString())
    if (!current || document.isClosed || version !== document.version || current.session.inspect().version !== version) return false
    const selected = current.session.retranslate(range)
    if (!selected) void vscode.window.showWarningMessage("请将光标放入浏览原文块，或选中需要重新翻译的块。")
    return selected
  }

  forget(uri: vscode.Uri): void {
    this.overrides.delete(uri.toString())
  }

  invalidate(document: vscode.TextDocument): void {
    this.sessions.get(document.uri.toString())?.session.invalidate(document.version)
  }

  async updateDocument(document: vscode.TextDocument): Promise<void> {
    const session = this.sessions.get(document.uri.toString())
    if (session) await this.update(session)
  }

  async start(document = vscode.window.activeTextEditor?.document, manual = true, scope: BrowseSnapshot["scope"] = "document"): Promise<void> {
    if (!document || this.disposed) return
    if (!this.documents.supports(document)) {
      await vscode.window.showWarningMessage("当前文件没有可用的 Markdown 或 TextMate 语法。")
      return
    }
    const id = document.uri.toString()
    if (manual) this.overrides.set(id, true)
    const current = this.sessions.get(id)
    if (current) {
      if (scope === "document") current.session.enableBrowse()
      return
    }
    try {
      const settings = getTranslationSettings(document.uri)
      const session = new BrowseSession(
        (batch, signal, force, completed, interests) => this.translations.translate(document, batch, signal, force, completed, settings, interests),
        () => this.render(),
        (error) => this.translations.diagnose(error, document.uri),
        scope
      )
      const documentSession = { document, session }
      this.sessions.set(id, documentSession)
      session.invalidate(document.version)
      await this.update(documentSession)
      if (!vscode.workspace.getConfiguration("editor", document.uri).get<boolean>("codeLens", true) && displayMode(document.uri) === "contrast")
        void vscode.window.showWarningMessage("当前文件关闭了 editor.codeLens，对照译文没有独立行空间；可开启 CodeLens、切换占位模式或使用悬停翻译。")
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "无法启动注释浏览模式。")
    }
  }

  private async update(documentSession: DocumentSession): Promise<void> {
    const document = documentSession.document
    const version = document.version
    try {
      const parsed = await this.documents.parse(document)
      if (this.disposed || this.sessions.get(document.uri.toString()) !== documentSession || document.isClosed || document.version !== version) return
      documentSession.session.update(parsed, version)
      this.refreshVisible()
    } catch (error) {
      if (this.disposed || this.sessions.get(document.uri.toString()) !== documentSession || document.isClosed || document.version !== version) return
      const code = this.translations.diagnose(error, document.uri)
      documentSession.session.update({ source: document.getText(), groups: [], errors: [code] }, version)
    }
  }

  stop(uri: vscode.Uri, manual: boolean, reason: CancellationReason = "browse-stopped"): void {
    const id = uri.toString()
    if (manual) this.overrides.set(id, false)
    const documentSession = this.sessions.get(id)
    this.sessions.delete(id)
    documentSession?.session.dispose(reason)
    this.stopped(uri, reason)
    this.render()
  }

  refreshVisible(): void {
    for (const documentSession of this.sessions.values()) {
      const ranges = vscode.window.visibleTextEditors
        .filter((editor) => editor.document === documentSession.document)
        .flatMap((editor) =>
          editor.visibleRanges.map((range) => ({
            start: editor.document.offsetAt(range.start),
            end: editor.document.offsetAt(range.end)
          }))
        )
      documentSession.session.setVisibleRanges(ranges)
    }
  }

  tryAutomatic(): void {
    if (this.disposed) return
    for (const editor of vscode.window.visibleTextEditors)
      if (
        this.documents.supports(editor.document) &&
        !this.overrides.has(editor.document.uri.toString()) &&
        !this.sessions.has(editor.document.uri.toString()) &&
        automatic(editor.document)
      )
        void this.start(editor.document, false)
  }

  render(): void {
    if (!this.disposed) {
      this.renderer.render()
      this.changed()
    }
  }

  async reconfigure(): Promise<void> {
    const documents = [...this.sessions.values()].map((item) => item.document)
    for (const document of documents) this.stop(document.uri, false, "configuration-changed")
    await Promise.all(documents.filter((document) => this.overrides.get(document.uri.toString()) === true || automatic(document)).map((document) => this.start(document, false)))
    this.tryAutomatic()
  }

  dispose(): void {
    this.disposed = true
    for (const { session } of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.overrides.clear()
    this.renderer.dispose()
  }
}
