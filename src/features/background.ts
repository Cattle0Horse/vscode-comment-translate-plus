import * as vscode from "vscode"
import type { DocumentReader } from "../host/documents.ts"
import type { TranslationRuntime } from "../host/translations.ts"
import { ParseFailure } from "../model/diagnostics.ts"

interface BackgroundRun {
  readonly controller: AbortController
  readonly tokenSource: vscode.CancellationTokenSource
}

interface ActiveFile {
  readonly uri: vscode.Uri
  readonly controller: AbortController
}

export class BackgroundWorkspace implements vscode.Disposable {
  private run: BackgroundRun | undefined
  private activeFile: ActiveFile | undefined
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
            for await (const uri of this.findFiles(tokenSource.token)) {
              controller.signal.throwIfAborted()
              result.files++
              progress.report({ message: "已处理 " + (result.files - 1) + " 个文件：" + vscode.workspace.asRelativePath(uri, false) })
              const fileController = new AbortController()
              const signal = AbortSignal.any([controller.signal, fileController.signal])
              this.activeFile = { uri, controller: fileController }
              try {
                const document = await vscode.workspace.openTextDocument(uri)
                signal.throwIfAborted()
                if (!this.documents.supports(document)) {
                  result.skipped++
                  continue
                }
                const parsed = await this.documents.parse(document, false, { cache: false, signal })
                for (const diagnostic of parsed.errors) this.translations.diagnose(new ParseFailure(diagnostic), uri)
                const units = parsed.groups.flatMap((group) => group.units)
                if (!units.length) {
                  result.skipped++
                  continue
                }
                await this.translations.translate(document, { units }, signal, false, undefined, undefined, undefined, () => 3, true)
                result.translated++
              } catch (error) {
                if (controller.signal.aborted || (error instanceof Error && error.message.startsWith("background-cache-full-"))) throw error
                if (signal.aborted) result.skipped++
                else {
                  result.failed++
                  this.translations.diagnose(error, uri)
                }
              } finally {
                this.activeFile = undefined
              }
            }
            void vscode.window.showInformationMessage(`后台翻译完成：${result.translated} 个文件，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`)
          } catch (error) {
            if (error instanceof Error && error.message === "background-cache-full-memory")
              void vscode.window.showWarningMessage("后台翻译已停止：内存缓存空间不足。已完成结果保留，请开启持久化缓存后重试。")
            else if (error instanceof Error && error.message === "background-cache-full-persistent")
              void vscode.window.showWarningMessage("后台翻译已停止：持久化缓存空间不足或不可用。已完成结果保留，请提高缓存容量或检查缓存状态后重试。")
            else if (!controller.signal.aborted) void vscode.window.showErrorMessage("后台翻译所有文件失败：" + (error instanceof Error ? error.message : String(error)))
          } finally {
            cancellation.dispose()
          }
        }
      )
    } finally {
      tokenSource.dispose()
      if (this.run === run) this.run = undefined
    }
  }

  cancel(reason = "user-cancelled"): void {
    const run = this.run
    if (!run) return
    run.controller.abort(reason)
    run.tokenSource.cancel()
  }

  cancelDocument(uri: vscode.Uri, reason = "document-changed"): void {
    if (this.activeFile?.uri.toString() === uri.toString()) this.activeFile.controller.abort(reason)
  }

  dispose(): void {
    this.disposed = true
    this.activeFile = undefined
    this.cancel("extension-disposed")
  }

  private async *findFiles(token: vscode.CancellationToken): AsyncGenerator<vscode.Uri> {
    const seen = new Set<string>()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const config = vscode.workspace.getConfiguration("commentTranslatePlus", folder.uri)
      const include = config.get<string[]>("auto.include", ["**/*"])
      const configured = config.get<unknown>("auto.exclude", [])
      const patterns = Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string" && value.length > 0) : []
      const excluded = patterns.length ? new vscode.RelativePattern(folder, "{" + patterns.join(",") + "}") : null
      for (const pattern of include) {
        if (token.isCancellationRequested) throw Error("background-cancelled")
        for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), excluded, undefined, token)) {
          if (token.isCancellationRequested) throw Error("background-cancelled")
          const id = uri.toString()
          if (seen.has(id)) continue
          seen.add(id)
          yield uri
        }
      }
    }
  }
}
