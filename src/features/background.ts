import * as vscode from "vscode"
import type { DocumentReader } from "../host/documents.ts"
import type { TranslationRuntime } from "../host/translations.ts"
import type { ParsedDocument } from "../model/document.ts"
import { memoryCacheMaxBytes, memoryCacheMaxEntries } from "../translation/store.ts"

interface BackgroundRun {
  readonly controller: AbortController
  readonly tokenSource: vscode.CancellationTokenSource
}

interface ActiveFile {
  readonly uri: vscode.Uri
  readonly controller: AbortController
}

interface BackgroundFile {
  readonly uri: vscode.Uri
  readonly document: vscode.TextDocument
  readonly parsed: ParsedDocument
  readonly version: number
}

export class BackgroundWorkspace implements vscode.Disposable {
  private run: BackgroundRun | undefined
  private activeFile: ActiveFile | undefined
  private readonly invalidated = new Set<string>()
  private disposed = false

  constructor(
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime
  ) {}

  get isRunning(): boolean {
    return this.run !== undefined
  }

  async translateAll(): Promise<void> {
    if (this.disposed) return
    if (this.run) {
      void vscode.window.showInformationMessage("后台翻译所有文件已在进行中。")
      return
    }
    this.invalidated.clear()
    const controller = new AbortController()
    const tokenSource = new vscode.CancellationTokenSource()
    const run = { controller, tokenSource }
    this.run = run
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "后台翻译所有文件",
          cancellable: true
        },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => {
            controller.abort("background-cancelled")
            tokenSource.cancel()
          })
          const result = { files: 0, translated: 0, skipped: 0, failed: 0 }
          try {
            const files = await this.prepareFiles(controller, tokenSource.token, progress, result)
            if (!this.capacity(files)) return
            for (const file of files) {
              controller.signal.throwIfAborted()
              if (this.invalidated.has(file.uri.toString()) || file.document.isClosed || file.document.version !== file.version) {
                result.skipped++
                continue
              }
              const fileController = new AbortController()
              const abortFile = () => fileController.abort(controller.signal.reason)
              controller.signal.addEventListener("abort", abortFile, { once: true })
              this.activeFile = { uri: file.uri, controller: fileController }
              try {
                await this.translations.translate(
                  file.document,
                  { units: file.parsed.groups.flatMap((group) => group.units) },
                  fileController.signal,
                  false,
                  undefined,
                  undefined,
                  undefined,
                  () => 3
                )
                result.translated++
              } catch (error) {
                if (controller.signal.aborted) throw error
                result.failed++
              } finally {
                controller.signal.removeEventListener("abort", abortFile)
                if (this.activeFile?.uri.toString() === file.uri.toString()) this.activeFile = undefined
              }
            }
            void vscode.window.showInformationMessage(`后台翻译完成：${result.translated} 个文件，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`)
          } catch (error) {
            if (!controller.signal.aborted) void vscode.window.showErrorMessage("后台翻译所有文件失败：" + (error instanceof Error ? error.message : String(error)))
          } finally {
            cancellation.dispose()
          }
        }
      )
    } finally {
      tokenSource.dispose()
      if (this.run === run) this.run = undefined
      this.invalidated.clear()
    }
  }

  cancel(reason = "user-cancelled"): void {
    const run = this.run
    if (!run) return
    run.controller.abort(reason)
    run.tokenSource.cancel()
  }

  cancelDocument(uri: vscode.Uri, reason = "document-changed"): void {
    if (!this.run) return
    this.invalidated.add(uri.toString())
    if (this.activeFile?.uri.toString() === uri.toString()) this.activeFile.controller.abort(reason)
  }

  dispose(): void {
    this.disposed = true
    this.activeFile = undefined
    this.invalidated.clear()
    this.cancel("extension-disposed")
  }

  private async prepareFiles(
    controller: AbortController,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    result: { files: number; translated: number; skipped: number; failed: number }
  ): Promise<readonly BackgroundFile[]> {
    const uris = await this.findFiles(token)
    const files: BackgroundFile[] = []
    for (const uri of uris) {
      controller.signal.throwIfAborted()
      result.files++
      progress.report({ message: `扫描 ${result.files}/${uris.length}：${vscode.workspace.asRelativePath(uri, false)}` })
      try {
        const document = await vscode.workspace.openTextDocument(uri)
        if (!this.documents.supports(document)) {
          result.skipped++
          continue
        }
        const parsed = await this.documents.parse(document)
        if (!parsed.groups.some((group) => group.units.length)) {
          result.skipped++
          continue
        }
        files.push({ uri, document, parsed, version: document.version })
      } catch (error) {
        if (controller.signal.aborted) throw error
        result.failed++
      }
    }
    return files
  }

  private capacity(files: readonly BackgroundFile[]): boolean {
    let entries = 0
    let bytes = 0
    for (const file of files)
      for (const group of file.parsed.groups)
        for (const unit of group.units) {
          entries++
          bytes += unit.text.length * 4 + 512
        }
    const config = vscode.workspace.getConfiguration("commentTranslatePlus")
    const persistent = config.get<boolean>("persistentCache", false)
    if (!persistent && (entries > memoryCacheMaxEntries || bytes > memoryCacheMaxBytes)) {
      void vscode.window.showWarningMessage("后台翻译已停止：预计译文超过当前内存缓存容量。请开启持久化缓存后重试。")
      return false
    }
    const configuredEntries = config.get<unknown>("persistentCacheMaxEntries", 10000)
    const configuredSize = config.get<unknown>("persistentCacheMaxSizeMB", 20)
    const maxEntries = typeof configuredEntries === "number" && Number.isInteger(configuredEntries) && configuredEntries >= 1 ? configuredEntries : 10000
    const maxBytes = (typeof configuredSize === "number" && Number.isInteger(configuredSize) && configuredSize >= 1 ? configuredSize : 20) * 1024 * 1024
    if (persistent && (entries > maxEntries || bytes > maxBytes)) {
      void vscode.window.showWarningMessage("后台翻译已停止：预计译文超过持久化缓存容量。请提高 persistentCacheMaxEntries 或 persistentCacheMaxSizeMB 后重试。")
      return false
    }
    return true
  }

  private async findFiles(token: vscode.CancellationToken): Promise<readonly vscode.Uri[]> {
    const files: vscode.Uri[] = []
    const seen = new Set<string>()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const config = vscode.workspace.getConfiguration("commentTranslatePlus", folder.uri)
      const configured = config.get<unknown>("auto.exclude", [])
      const patterns = Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string" && value.length > 0) : []
      const excluded = patterns.length ? new vscode.RelativePattern(folder, "{" + patterns.join(",") + "}") : undefined
      for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), excluded, undefined, token)) {
        if (token.isCancellationRequested) throw Error("background-cancelled")
        const id = uri.toString()
        if (seen.has(id)) continue
        seen.add(id)
        files.push(uri)
      }
    }
    return files
  }
}
