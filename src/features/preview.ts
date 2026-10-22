import * as vscode from "vscode"
import { isMarkdownDocument } from "../host/configuration.ts"
import { describeError } from "../model/diagnostics.ts"
import type { CancellationReason } from "../model/diagnostics.ts"
import { translatedMarkdown, progressiveMarkdown, previewLoadingMarker } from "../documents/presentation.ts"

const scheme = "comment-translate-plus-preview"

export function markdownPreviewUri(source: vscode.Uri): vscode.Uri {
  const authority = [...new TextEncoder().encode(source.toString())].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return vscode.Uri.from({ scheme, authority, path: source.path })
}

interface Preview {
  readonly source: vscode.Uri
  readonly uri: vscode.Uri
  text: string
  mtime: number
  controller?: AbortController
}

/** One read-only filesystem serves translated documents and their original relative resources. */
export class MarkdownPreview implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly views = new Map<string, Preview>()
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.changes.event
  private readonly registration = vscode.workspace.registerFileSystemProvider(scheme, this, { isReadonly: true })
  private readonly opened: vscode.Disposable

  constructor(
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime,
    private readonly retranslateSource: (document: vscode.TextDocument) => Promise<void>
  ) {
    this.opened = vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== scheme) return
      const view = this.views.get(this.source(document.uri).toString())
      // A cache hit can finish before the initial read becomes an open document.
      if (view?.uri.toString() === document.uri.toString() && document.getText() !== view.text) this.publish(view, view.text)
    })
  }

  async open(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isMarkdownDocument(document) || document.uri.scheme === scheme) {
      void vscode.window.showWarningMessage("翻译预览支持 Markdown 和指令文件。")
      return
    }
    const view = this.view(document.uri)
    if (view.controller?.signal.aborted) void this.refresh(view)
    await vscode.workspace.openTextDocument(view.uri)
    await vscode.commands.executeCommand("vscode.openWith", view.uri, "vscode.markdown.preview.editor", { viewColumn: vscode.ViewColumn.Beside })
  }

  async retranslate(value?: unknown): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const uri = value instanceof vscode.Uri ? value : input instanceof vscode.TabInputCustom ? input.uri : undefined
    if (!uri || uri.scheme !== scheme) return
    await this.retranslateSource(await vscode.workspace.openTextDocument(this.source(uri)))
  }

  private publish(view: Preview, text: string): void {
    view.text = text
    view.mtime = Math.max(view.mtime + 1, Date.now())
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri: view.uri }])
  }

  private async refresh(view: Preview, reason: CancellationReason = "preview-refreshed"): Promise<void> {
    view.controller?.abort(reason)
    const controller = new AbortController()
    view.controller = controller
    try {
      const document = await vscode.workspace.openTextDocument(view.source)
      controller.signal.throwIfAborted()
      const version = document.version
      const parsed = await this.documents.parse(document)
      controller.signal.throwIfAborted()
      if (document.isClosed || document.version !== version) return
      this.publish(view, progressiveMarkdown(parsed, new Map()))
      let nextRefresh = 0
      const translations = await this.translations.translateUnits(document, parsed, controller.signal, (translations) => {
        if (!controller.signal.aborted && !document.isClosed && document.version === version && performance.now() >= nextRefresh) {
          this.publish(view, progressiveMarkdown(parsed, translations))
          nextRefresh = performance.now() + 250
        }
      })
      controller.signal.throwIfAborted()
      if (document.isClosed || document.version !== version) return
      const translated = translatedMarkdown(parsed, translations)
      this.publish(view, (parsed.errors.length ? "> 部分区域无法解析，已保留原文。\n\n" : "") + translated)
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = this.translations.diagnose(error, view.source)
        const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === view.source.toString())
        this.publish(view, "> 翻译失败：" + describeError(code) + "\n\n" + (document?.getText() ?? ""))
        controller.abort("request-failed")
      }
    }
  }

  update(uri?: vscode.Uri, reason: CancellationReason = "preview-refreshed"): void {
    for (const view of this.views.values()) if (!uri || view.source.toString() === uri.toString()) void this.refresh(view, reason)
  }

  has(uri: vscode.Uri): boolean {
    return this.views.has(uri.toString())
  }

  cancel(uri: vscode.Uri, reason: CancellationReason, message = "翻译已取消，重新打开预览可继续。"): void {
    const view = this.views.get(uri.toString())
    if (!view) return
    view.controller?.abort(reason)
    const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    this.publish(view, "> " + message + "\n\n" + (document?.getText() ?? ""))
  }

  close(uri: vscode.Uri): void {
    if (uri.scheme !== scheme) {
      this.cancel(uri, "document-closed", "源文件已关闭，重新打开预览可继续。")
      return
    }
    const source = this.source(uri)
    const view = this.views.get(source.toString())
    if (view && uri.path === source.path) {
      view.controller?.abort("preview-closed")
      this.views.delete(source.toString())
    }
  }

  private source(uri: vscode.Uri): vscode.Uri {
    try {
      if (!/^(?:[a-f0-9]{2})+$/.test(uri.authority)) throw Error()
      const bytes = Uint8Array.from(uri.authority.match(/../g)!, (value) => parseInt(value, 16))
      const source = vscode.Uri.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), true)
      if (source.scheme === scheme) throw Error()
      return source
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
  }

  private view(source: vscode.Uri): Preview {
    let view = this.views.get(source.toString())
    if (!view) {
      view = { source, uri: markdownPreviewUri(source), text: previewLoadingMarker, mtime: Date.now() }
      this.views.set(source.toString(), view)
      void this.refresh(view)
    }
    return view
  }

  private resource(uri: vscode.Uri): vscode.Uri {
    return this.source(uri).with({ path: uri.path, query: uri.query, fragment: uri.fragment })
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const source = this.source(uri)
    if (uri.path === source.path) {
      const view = this.view(source)
      return { type: vscode.FileType.File, ctime: 0, mtime: view.mtime, size: new TextEncoder().encode(view.text).length, permissions: vscode.FilePermission.Readonly }
    }
    return vscode.workspace.fs.stat(this.resource(uri))
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const source = this.source(uri)
    return uri.path === source.path ? new TextEncoder().encode(this.view(source).text) : vscode.workspace.fs.readFile(this.resource(uri))
  }

  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(this.resource(uri))
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions("翻译预览只读。")
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions("翻译预览只读。")
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions("翻译预览只读。")
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions("翻译预览只读。")
  }

  dispose(): void {
    for (const view of this.views.values()) view.controller?.abort("extension-disposed")
    this.views.clear()
    this.opened.dispose()
    this.registration.dispose()
    this.changes.dispose()
  }
}

import type { DocumentReader } from "../host/documents.ts"
import type { TranslationRuntime } from "../host/translations.ts"
