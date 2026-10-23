import * as vscode from "vscode"
import { getTranslationSettings, isMarkdownDocument, isYamlDocument } from "../host/configuration.ts"
import { translatedMarkdown } from "../documents/presentation.ts"
import { assertMarkdownStructure } from "../documents/validation.ts"
import { assertYamlStructure } from "../documents/yaml.ts"
import type { TextUnit } from "../model/document.ts"
import { describeError } from "../model/diagnostics.ts"
import type { CancellationReason } from "../model/diagnostics.ts"
import { requestPolicyIdentity } from "../translation/settings.ts"
import type { DocumentReader } from "../host/documents.ts"
import type { TranslationRuntime } from "../host/translations.ts"
import type { BrowseSnapshot } from "./browse/session.ts"

export interface SourceReplacement {
  readonly uri: string
  readonly version: number
  readonly start: number
  readonly end: number
  readonly source: string
  readonly text: string
  readonly identity: string
}

export function replacementIdentity(uri: vscode.Uri): string {
  const settings = getTranslationSettings(uri)
  return JSON.stringify([settings.identity, requestPolicyIdentity(settings)])
}

export class SourceReplacementAction implements vscode.Disposable {
  private readonly replacements = new Map<string, AbortController>()
  private readonly registration = vscode.commands.registerCommand("commentTranslatePlus.replaceHover", (value) => this.replace(value))
  constructor(
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime,
    private readonly inspect: (uri: vscode.Uri) => BrowseSnapshot | undefined
  ) {}

  async translateAndReplace(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor
    if (!editor || this.documents.isOwnOutput(editor.document)) return false
    const document = editor.document
    if (!document.isUntitled && vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== true) {
      void vscode.window.showWarningMessage("当前文件只读，无法替换。")
      return false
    }
    if (editor.selections.length !== 1) {
      void vscode.window.showWarningMessage("翻译并替换仅支持一个选区或光标，请先取消多光标。")
      return false
    }
    const selection = editor.selection
    const uri = document.uri.toString()
    const version = document.version
    const controller = new AbortController()
    this.replacements.get(uri)?.abort("retranslation")
    this.replacements.set(uri, controller)
    try {
      const identity = replacementIdentity(document.uri)
      const unit: TextUnit | undefined = selection.isEmpty ? await this.documents.target(document, document.offsetAt(selection.active)) : this.documents.selection(document, selection)
      controller.signal.throwIfAborted()
      if (document.isClosed || document.version !== version) return false
      if (!unit?.text.trim()) {
        void vscode.window.showWarningMessage("请先选择要翻译的文本，或将光标放入注释、字符串或 Markdown 单元。")
        return false
      }
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "注释翻译+：翻译并替换", cancellable: true }, async (_progress, token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort("user-cancelled"))
        try {
          if (token.isCancellationRequested) controller.abort("user-cancelled")
          const cached = selection.isEmpty ? this.inspect(document.uri)?.units.find((item) => item.id === unit.id) : undefined
          const translated = cached?.translation ?? (await this.translations.translate(document, { units: [unit] }, controller.signal)).get(unit.id)
          controller.signal.throwIfAborted()
          if (translated === undefined) return false
          return this.replace({ uri, version, start: unit.start, end: unit.end, source: unit.text, text: translated, identity })
        } finally {
          cancellation.dispose()
        }
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = this.translations.diagnose(error, document.uri)
        void vscode.window.showWarningMessage(describeError(code))
      }
      return false
    } finally {
      if (this.replacements.get(uri) === controller) this.replacements.delete(uri)
    }
  }

  private async replace(value: unknown): Promise<boolean> {
    if (!value || typeof value !== "object") return false
    const { uri, version, start, end, source, text, identity } = value as Partial<SourceReplacement>
    if (
      typeof uri !== "string" ||
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      start < 0 ||
      typeof end !== "number" ||
      !Number.isInteger(end) ||
      end <= start ||
      typeof source !== "string" ||
      source.length !== end - start ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 200000 ||
      typeof identity !== "string"
    )
      return false
    const editor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri)
    const document = editor?.document
    if (!editor || !document || document.isClosed) {
      void vscode.window.showWarningMessage("目标文件已关闭或不再可见，请打开该文件后重新翻译或悬停。")
      return false
    }
    if (document.version !== version) {
      void vscode.window.showWarningMessage("获取译文后文档已被编辑，请重新翻译或悬停后替换。")
      return false
    }
    if (!document.isUntitled && vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== true) {
      void vscode.window.showWarningMessage("当前文件只读，无法替换。")
      return false
    }
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end))
    try {
      if (end > document.getText().length || document.getText(range) !== source) {
        void vscode.window.showWarningMessage("待替换的原文范围已变化，请重新翻译或悬停后替换。")
        return false
      }
      if (replacementIdentity(document.uri) !== identity) {
        void vscode.window.showWarningMessage("翻译配置已变化，请重新翻译或悬停获取新配置的译文。")
        return false
      }
      if (isMarkdownDocument(document)) {
        const original = document.getText()
        const parsed = await this.documents.parse(document, true)
        const unit = parsed.groups.flatMap((group) => group.units).find((unit) => unit.start === start && unit.end === end)
        if (unit?.embedding) translatedMarkdown(parsed, new Map([[unit.id, text]]))
        else assertMarkdownStructure(original, original.slice(0, start) + text + original.slice(end))
        if (document.isClosed || document.version !== version || document.getText(range) !== source || replacementIdentity(document.uri) !== identity) return false
      }
      if (isYamlDocument(document)) {
        const original = document.getText()
        assertYamlStructure(original, original.slice(0, start) + text + original.slice(end))
      }
      if (text === source) return true
      const applied = await editor.edit((edit) => edit.replace(range, text), { undoStopBefore: true, undoStopAfter: true })
      if (!applied) void vscode.window.showWarningMessage("编辑器未接受替换，原文已保留。")
      else if (vscode.window.activeTextEditor === editor) await vscode.commands.executeCommand("editor.action.hideHover")
      return applied
    } catch (error) {
      const code = this.translations.diagnose(error, document.uri)
      void vscode.window.showWarningMessage(describeError(code))
      return false
    }
  }

  cancel(uri: vscode.Uri, reason: CancellationReason): void {
    this.replacements.get(uri.toString())?.abort(reason)
  }

  dispose(): void {
    for (const controller of this.replacements.values()) controller.abort("extension-disposed")
    this.replacements.clear()
    this.registration.dispose()
  }
}
