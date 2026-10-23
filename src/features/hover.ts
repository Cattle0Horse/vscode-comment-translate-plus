import * as vscode from "vscode"
import { translatedMarkdown, translationDisplayText } from "../documents/presentation.ts"
import type { TranslationInput } from "../model/translation.ts"
import type { TextUnit } from "../model/document.ts"
import { describeError } from "../model/diagnostics.ts"
import type { CancellationReason } from "../model/diagnostics.ts"

interface PendingHover {
  readonly controller: AbortController
  target?: string
}

export class TranslationHover implements vscode.Disposable, vscode.HoverProvider {
  private readonly guards = new Set<string>()
  private readonly pending = new Map<string, Set<PendingHover>>()

  private readonly registration: vscode.Disposable

  constructor(
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime,
    private readonly inspect: (uri: vscode.Uri) => BrowseSnapshot | undefined,
    private readonly editing: (uri: vscode.Uri) => boolean
  ) {
    this.registration = vscode.languages.registerHoverProvider("*", this)
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (this.documents.isOwnOutput(document)) return
    // Hover can be retriggered by editor layout changes while typing.
    // Do not bypass the shared edit debounce for browse/preview documents.
    if (this.editing(document.uri)) return
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", document.uri)
    if (!config.get<boolean>("hover.enabled", true)) return
    const version = document.version
    const uri = document.uri.toString()
    const key = uri + ":" + version + ":" + document.offsetAt(position)
    if (this.guards.has(key) || token.isCancellationRequested) return
    const controller = new AbortController()
    const request: PendingHover = { controller }
    const active = this.pending.get(uri) ?? new Set()
    active.add(request)
    this.pending.set(uri, active)
    try {
      const contents: vscode.MarkdownString[] = []
      let header: vscode.MarkdownString | undefined
      let range: vscode.Range | undefined
      const offset = document.offsetAt(position)
      let unit: TextUnit | undefined
      const editor = vscode.window.activeTextEditor
      const selection =
        editor?.document === document && config.get<boolean>("hover.selection", true)
          ? editor.selections.find((selection) => !selection.isEmpty && selection.contains(position))
          : undefined
      if (selection) {
        unit = this.documents.selection(document, selection)
      } else {
        unit = await this.documents.target(document, offset)
        if (unit?.kind && !config.get<boolean>("hover." + (unit.kind === "comment" ? "comments" : "strings"), unit.kind === "comment")) unit = undefined
      }
      controller.signal.throwIfAborted()
      if (token.isCancellationRequested || document.isClosed || document.version !== version) return
      const target = unit
        ? new vscode.Range(document.positionAt(unit.start), document.positionAt(unit.end))
        : (document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position))
      request.target = version + ":" + document.offsetAt(target.start) + ":" + document.offsetAt(target.end)
      // Native hover restarts as the mouse crosses characters; only a different text target cancels its translation.
      for (const other of active) if (other !== request && other.target !== undefined && other.target !== request.target) other.controller.abort("hover-target-changed")
      if (unit) {
        const identity = replacementIdentity(document.uri)
        const cached = this.inspect(document.uri)?.units.find((item) => item.id === unit.id)
        const batch: TranslationInput = { units: [unit] }
        const translated = cached?.translation ?? (await this.translations.translate(document, batch, controller.signal)).get(unit.id)
        if (translated && translated !== unit.text) {
          const content = new vscode.MarkdownString()
          content.appendCodeblock(translationDisplayText(translated, unit.format, unit), unit.language ?? document.languageId)
          contents.push(content)
          range = new vscode.Range(document.positionAt(unit.start), document.positionAt(unit.end))
          header = new vscode.MarkdownString("[注释翻译+]", true)
          if (document.isUntitled || vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === true) {
            const replacement: SourceReplacement = { uri, version, start: unit.start, end: unit.end, source: unit.text, text: translated, identity }
            // VS Code decodes command queries again before parsing JSON; protect literal percent escapes in all snapshot fields.
            const args = encodeURIComponent(JSON.stringify([replacement]).replaceAll("%", "\\u0025"))
              .replaceAll("(", "%28")
              .replaceAll(")", "%29")
            header.appendMarkdown(" &nbsp; [$(replace)](command:commentTranslatePlus.replaceHover?" + args + ' "替换")')
            header.isTrusted = { enabledCommands: ["commentTranslatePlus.replaceHover"] }
          }
        }
      }
      if (config.get<boolean>("hover.documentation", true)) {
        this.guards.add(key)
        let others: vscode.Hover[] | undefined
        try {
          others = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, position)
        } finally {
          this.guards.delete(key)
        }
        for (const hover of others ?? []) {
          const group: vscode.MarkdownString[] = []
          let changed = false
          for (const item of hover.contents) {
            const markdown = typeof item === "string" ? item : "language" in item ? new vscode.MarkdownString().appendCodeblock(item.value, item.language).value : item.value
            if (!markdown || markdown.includes("[注释翻译+]")) continue
            const translated = await this.translateMarkdown(document, markdown, controller.signal)
            changed ||= translated !== markdown
            const content = new vscode.MarkdownString(translated, true)
            content.baseUri = typeof item !== "string" && "baseUri" in item ? item.baseUri : document.uri
            group.push(content)
          }
          if (changed) {
            contents.push(...group)
            range ??= hover.range
          }
        }
        for (const diagnostic of vscode.languages.getDiagnostics(document.uri)) {
          if (!diagnostic.range.contains(position)) continue
          const translated = await this.translateMarkdown(document, diagnostic.message, controller.signal)
          if (translated === diagnostic.message) continue
          const content = new vscode.MarkdownString(translated, true)
          content.baseUri = document.uri
          const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
          const metadata = (diagnostic.source ?? "") + (code === undefined ? "" : "(" + code + ")")
          if (metadata) content.appendText(" " + metadata)
          contents.push(content)
          range ??= diagnostic.range
        }
      }
      controller.signal.throwIfAborted()
      if (token.isCancellationRequested || !contents.length || document.isClosed || document.version !== version) return
      if (config.get<boolean>("hover.nearCursor", true)) {
        const near = new vscode.Range(position.line, Math.max(0, position.character - 10), position.line, Math.min(document.lineAt(position.line).text.length, position.character + 10))
        range = range?.intersection(near) ?? near
      }
      return new vscode.Hover(header ? [header, ...contents] : contents, range)
    } catch (error) {
      if (token.isCancellationRequested || controller.signal.aborted || document.version !== version || document.isClosed) return
      const code = this.translations.diagnose(error, document.uri)
      return new vscode.Hover(new vscode.MarkdownString("[注释翻译+]\n\n").appendText(describeError(code)), new vscode.Range(position, position))
    } finally {
      active.delete(request)
      if (!active.size) this.pending.delete(uri)
    }
  }

  private async translateMarkdown(document: vscode.TextDocument, markdown: string, signal: AbortSignal): Promise<string> {
    const parsed = await this.documents.parseSource(markdown, "markdown", () => signal.throwIfAborted())
    if (!parsed.groups.some((group) => group.units.length)) return markdown
    return translatedMarkdown(parsed, await this.translations.translateUnits(document, parsed, signal))
  }

  cancel(uri: vscode.Uri, reason: CancellationReason): void {
    for (const request of this.pending.get(uri.toString()) ?? []) request.controller.abort(reason)
  }

  dispose(): void {
    for (const active of this.pending.values()) for (const request of active) request.controller.abort("extension-disposed")
    this.pending.clear()
    this.registration.dispose()
  }
}

import { replacementIdentity } from "./replacement.ts"
import type { SourceReplacement } from "./replacement.ts"
import type { DocumentReader } from "../host/documents.ts"
import type { TranslationRuntime } from "../host/translations.ts"
import type { BrowseSnapshot } from "./browse/session.ts"
