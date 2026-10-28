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
import { describeError, TranslationFailure, ParseFailure } from "../model/diagnostics.ts"
import { TermFiles } from "./termFiles.ts"
import type { prepareSelection } from "../documents/selection.ts"
import { PersistentCache } from "./persistentCache.ts"
import { join } from "node:path"

export class TranslationRuntime implements vscode.Disposable {
  readonly terms: TermFiles
  private readonly gate = new RequestGate(2, 2)
  private readonly persistent: PersistentCache
  private readonly store: TranslationStore
  private readonly service = new TranslationService()
  private readonly output = vscode.window.createOutputChannel("注释翻译+")
  private readonly log = new TranslationLog((entry) => this.output.appendLine(entry))
  private disposed = false
  constructor(context: vscode.ExtensionContext, home?: string) {
    this.persistent = new PersistentCache(join(context.globalStorageUri.fsPath, "translation-cache.sqlite"), () => {
      this.log.write("warning", "持久化翻译缓存读写失败或数据损坏，未命中项将继续正常翻译。")
      if (!this.disposed) void vscode.window.showWarningMessage("持久化翻译缓存读写失败或数据损坏，未命中项将继续正常翻译。")
    })
    this.store = new TranslationStore(this.persistent)
    this.terms = new TermFiles(context, home)
    this.configureLog()
    void this.configureCache()
  }

  configureCache(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const config = vscode.workspace.getConfiguration("commentTranslatePlus")
    const enabled = config.get<unknown>("persistentCache", false)
    const maxEntries = config.get<unknown>("persistentCacheMaxEntries", 10000)
    const maxSize = config.get<unknown>("persistentCacheMaxSizeMB", 20)
    if (
      typeof enabled !== "boolean" ||
      typeof maxEntries !== "number" ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 1000000 ||
      typeof maxSize !== "number" ||
      !Number.isInteger(maxSize) ||
      maxSize < 1 ||
      maxSize > 1024
    ) {
      this.log.write("warning", "持久化缓存配置无效，继续使用上次有效配置（初始为关闭）。")
      return Promise.resolve()
    }
    return this.persistent.configure({ enabled, maxEntries, maxBytes: maxSize * 1024 * 1024 })
  }

  async showCacheUsage(): Promise<void> {
    const size = (bytes: number) => {
      const divisor = bytes < 1024 ? 1 : bytes < 1024 * 1024 ? 1024 : 1024 * 1024
      return (bytes / divisor).toLocaleString("zh-CN", { maximumFractionDigits: 3 }) + (divisor === 1 ? " B" : divisor === 1024 ? " KiB" : " MiB")
    }
    while (!this.disposed) {
      const snapshot = this.persistent.snapshot()
      const items: (vscode.QuickPickItem & { action?: "refresh" | "directory" | "settings" })[] = [
        {
          label: "持久化缓存",
          description: snapshot.state === "failed" ? "存储故障，仅使用内存缓存" : snapshot.state === "ready" ? "已开启" : "已关闭"
        },
        { label: "缓存条目", description: snapshot.entries === undefined ? "无法读取" : `${snapshot.entries.toLocaleString("zh-CN")} / ${snapshot.maxEntries.toLocaleString("zh-CN")} 项` },
        {
          label: "缓存容量",
          description: snapshot.bytes === undefined ? "无法读取" : `${size(snapshot.bytes)} / ${size(snapshot.maxBytes)}（${((snapshot.bytes / snapshot.maxBytes) * 100).toFixed(1)}%）`,
          detail: "已提交的摘要与译文有效载荷，受条数和容量上限约束。"
        },
        {
          label: "磁盘文件大小",
          description: snapshot.diskBytes === undefined ? "无法读取" : size(snapshot.diskBytes),
          detail: "数据库、WAL 与 SHM 文件合计，包含索引、空闲页及事务日志，可能大于缓存容量。"
        },
        { label: "待写入变更", description: `${snapshot.pendingChanges} 项`, detail: "当前窗口尚未提交的新增、更新或删除；不计入上方已提交统计。" },
        { label: "刷新", action: "refresh" },
        { label: "打开缓存目录", description: snapshot.directory, action: "directory" },
        { label: "打开缓存设置", action: "settings" }
      ]
      const selected = await vscode.window.showQuickPick(items, { title: "注释翻译+：缓存使用情况", placeHolder: "按需查看持久化缓存统计，选择刷新获取最新数据" })
      if (!selected || this.disposed) return
      if (selected.action === "settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:cattle-horse.vscode-comment-translate-plus persistentCache")
        return
      }
      if (selected.action === "directory") {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(snapshot.directory))
          if (!(await vscode.env.openExternal(vscode.Uri.file(snapshot.directory)))) throw Error("无法打开缓存目录。")
        } catch (error) {
          void vscode.window.showWarningMessage(
            error instanceof vscode.FileSystemError && error.code === "FileNotFound" ? "缓存目录尚未创建。" : "无法打开缓存目录，请检查目录是否存在及访问权限。"
          )
        }
        return
      }
    }
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

  async translateSelection(document: vscode.TextDocument, selection: ReturnType<typeof prepareSelection>, signal: AbortSignal): Promise<string> {
    const translations = new Map<string, string>()
    try {
      await this.translate(document, selection, signal, false, (item) => translations.set(item.id, item.text))
    } catch (error) {
      // The request already reports failed items. Keep their source while displaying accepted neighbours.
      if (!(error instanceof TranslationFailure) || !error.reported || !translations.size) throw error
    }
    signal.throwIfAborted()
    return selection.restore(translations)
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
    this.store.clear("configuration-changed", true)
    this.service.clear()
  }

  diagnose(error: unknown, uri?: vscode.Uri): string {
    const message = error instanceof Error ? error.message : ""
    const code = /^[a-z][a-z0-9-]+$/.test(message) ? message : "translation-failed"
    let location = uri ? vscode.workspace.asRelativePath(uri, false) : ""
    if (uri && error instanceof ParseFailure) {
      const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
      const position = document?.positionAt(error.diagnostic.range.start)
      if (position) location += ":" + (position.line + 1) + ":" + (position.character + 1)
    }
    if (!(error instanceof TranslationFailure && error.reported)) this.log.write("error", (location ? location + "：" : "") + describeError(code) + "（" + code + "）")
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

  async dispose(): Promise<void> {
    this.disposed = true
    this.terms.dispose()
    this.store.clear()
    this.service.clear()
    this.log.resetReferences()
    this.gate.dispose()
    await this.persistent.close()
    this.output.dispose()
  }
}
