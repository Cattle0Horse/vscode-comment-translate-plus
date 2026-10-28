import * as vscode from "vscode"
import { parsePreserveTerms } from "../documents/terms.ts"
import { parseTermFile, termSource } from "../documents/termFiles.ts"
import type { PreserveTerms } from "../model/translation.ts"
import { TranslationFailure } from "../model/diagnostics.ts"

interface Snapshot {
  readonly sources: readonly string[]
  readonly texts: readonly string[]
}

interface Entry {
  readonly sources: readonly string[]
  revision: number
  loaded: number
  controller?: AbortController
  pending?: Promise<PreserveTerms>
  value?: PreserveTerms
  failure?: TranslationFailure
  texts?: readonly string[]
  released?: boolean
}

const maximumBytes = 2_000_000

async function fingerprint(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

/** Owns loaded, compiled snapshots and scheduled/manual refresh for this application. */
export class TermFiles implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setInterval>
  private readonly configuration: vscode.Disposable
  private persistence = Promise.resolve()
  private disposed = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly home?: string
  ) {
    this.configureRefresh()
    this.configuration = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("commentTranslatePlus.preserveTermsRefreshSeconds")) this.configureRefresh()
      if (event.affectsConfiguration("commentTranslatePlus.preserveTerms")) {
        for (const entry of this.entries.values()) this.release(entry)
        this.entries.clear()
      }
    })
  }

  private configureRefresh(): void {
    clearInterval(this.timer)
    this.timer = undefined
    const seconds = vscode.workspace.getConfiguration("commentTranslatePlus").get<unknown>("preserveTermsRefreshSeconds", 900)
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
      void vscode.window.showWarningMessage("preserveTermsRefreshSeconds 必须是 0–86400 的整数；当前已停用定时刷新，可手动刷新保留词。")
      return
    }
    if (seconds)
      this.timer = setInterval(() => {
        for (const entry of this.entries.values()) if (!entry.pending) void this.reload(entry).catch(() => {})
      }, seconds * 1000)
  }

  async get(uri?: vscode.Uri): Promise<PreserveTerms> {
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", uri)
    const values = config.get<unknown>("preserveTerms")
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) throw Error("preserveTerms 必须是 JSON/JSONC 文件路径或 HTTPS 地址的数组。")
    if (values.length > 32) throw Error("preserveTerms 最多支持 32 个文件来源。")
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() : undefined
    const sources = [...new Set(values.map((value: string) => termSource(value, folder, this.home)))].sort()
    // An unset setting uses the extension's bundled list; [] explicitly disables preservation.
    const configured = config.inspect<readonly string[]>("preserveTerms")
    if (configured && configured.globalValue === undefined && configured.workspaceValue === undefined && configured.workspaceFolderValue === undefined)
      sources.push(vscode.Uri.joinPath(this.context.extensionUri, "resources/preserve-terms.json").toString())
    const key = JSON.stringify(sources)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { sources, revision: 0, loaded: -1 }
      this.entries.set(key, entry)
      if (this.entries.size > 16) {
        const [oldestKey, oldest] = this.entries.entries().next().value!
        this.release(oldest)
        this.entries.delete(oldestKey)
      }
    } else {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return this.load(entry)
  }

  async refresh(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.reload(entry)))
    const failed = results.find((result) => result.status === "rejected")
    if (failed) throw failed.reason
  }

  private reload(entry: Entry): Promise<PreserveTerms> {
    entry.revision++
    entry.controller?.abort()
    return this.load(entry)
  }

  private load(entry: Entry): Promise<PreserveTerms> {
    if (this.disposed) return Promise.reject(Error("extension-disposed"))
    if (entry.pending) return entry.pending
    if (entry.loaded === entry.revision) {
      if (entry.value) return Promise.resolve(entry.value)
      if (entry.failure) return Promise.reject(entry.failure)
    }
    entry.pending = this.read(entry).finally(() => {
      entry.pending = undefined
    })
    return entry.pending
  }

  private async compile(snapshot: Snapshot): Promise<PreserveTerms> {
    const literals = new Set<string>()
    const expressions = new Map<string, RegExp>()
    for (const [index, source] of snapshot.sources.entries()) {
      try {
        const rules = parsePreserveTerms(parseTermFile(snapshot.texts[index], source))
        for (const literal of rules.literals) literals.add(literal)
        for (const expression of rules.expressions) expressions.set(JSON.stringify([expression.source, expression.flags]), expression)
      } catch (error) {
        throw Error(source + "：" + (error instanceof Error ? error.message : "词表无效"))
      }
    }
    const identity = JSON.stringify([[...literals].sort(), [...expressions.keys()].sort()])
    return { literals, expressions: [...expressions.values()], identity: await fingerprint(identity) }
  }

  private async read(entry: Entry): Promise<PreserveTerms> {
    while (!this.disposed && !entry.released) {
      const revision = entry.revision
      const controller = new AbortController()
      entry.controller = controller
      try {
        const texts = await Promise.all(entry.sources.map((source) => this.readText(source, controller.signal)))
        const snapshot = { sources: entry.sources, texts }
        if (texts.reduce((total, text) => total + text.length, 0) > maximumBytes) throw Error("合并词表超过 200 万字符上限。")
        const compiled = entry.value && entry.texts?.every((text, index) => text === texts[index]) ? entry.value : await this.compile(snapshot)
        if (this.disposed || entry.released) throw Error("extension-disposed")
        if (revision !== entry.revision) continue
        entry.value = entry.value?.identity === compiled.identity ? entry.value : compiled
        entry.loaded = revision
        entry.texts = texts
        entry.failure = undefined
        if (entry.sources.some((source) => /^https?:/u.test(source))) this.save(snapshot)
        return entry.value
      } catch (error) {
        controller.abort()
        if (this.disposed || entry.released) throw Error("extension-disposed")
        if (revision !== entry.revision) continue
        if (!entry.value) {
          const saved = this.context.globalState.get<Snapshot[]>("preserveTermSnapshots", []).find((snapshot) => JSON.stringify(snapshot.sources) === JSON.stringify(entry.sources))
          if (saved) {
            try {
              entry.value = await this.compile(saved)
            } catch {
              /* An invalid stored snapshot cannot become an empty successful list. */
            }
          }
        }
        if (this.disposed || entry.released) throw Error("extension-disposed")
        if (revision !== entry.revision) continue
        const message =
          "保留词文件加载失败：" +
          (error instanceof Error ? error.message : "读取失败") +
          (entry.value ? "。继续使用上次有效词表，可执行“刷新保留词”重试。" : "。请检查文件后执行“刷新保留词”。")
        const repeated = entry.failure?.message === message
        entry.failure = new TranslationFailure(message, true)
        if (!repeated) void vscode.window.showWarningMessage(message)
        entry.loaded = revision
        if (entry.value) return entry.value
        throw entry.failure
      } finally {
        if (entry.controller === controller) entry.controller = undefined
      }
    }
    throw Error("extension-disposed")
  }

  private async readText(source: string, signal: AbortSignal): Promise<string> {
    try {
      if (!/^https?:/u.test(source)) {
        const uri = vscode.Uri.parse(source)
        if ((await vscode.workspace.fs.stat(uri)).size > maximumBytes) throw Error("文件超过 2 MB 上限")
        const bytes = await vscode.workspace.fs.readFile(uri)
        signal.throwIfAborted()
        if (bytes.byteLength > maximumBytes) throw Error("文件超过 2 MB 上限")
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      }
      const response = await fetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), credentials: "omit", redirect: "error" })
      if (!response.ok) {
        await response.body?.cancel()
        throw Error("HTTP " + response.status)
      }
      const reader = response.body?.getReader()
      if (!reader) throw Error("响应体为空")
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let size = 0
      let text = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maximumBytes) throw Error("文件超过 2 MB 上限")
          text += decoder.decode(value, { stream: true })
        }
        return text + decoder.decode()
      } finally {
        await reader.cancel()
      }
    } catch (error) {
      throw Error(source + "：" + (error instanceof Error ? error.message : "读取失败"))
    }
  }

  private save(snapshot: Snapshot): void {
    this.persistence = this.persistence
      .then(async () => {
        const previous = this.context.globalState.get<Snapshot[]>("preserveTermSnapshots", [])
        const key = JSON.stringify(snapshot.sources)
        await this.context.globalState.update("preserveTermSnapshots", [...previous.filter((item) => JSON.stringify(item.sources) !== key), snapshot].slice(-4))
      })
      .catch(() => {
        void vscode.window.showWarningMessage("保留词离线快照保存失败，重载后离线使用可能不可用。")
      })
  }

  private release(entry: Entry): void {
    entry.released = true
    entry.controller?.abort()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.configuration.dispose()
    for (const entry of this.entries.values()) this.release(entry)
    this.entries.clear()
  }
}
