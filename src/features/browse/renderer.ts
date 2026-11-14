import * as vscode from "vscode"
import type { BrowseSnapshot } from "./session.ts"
import { displayMode } from "../../host/configuration.ts"
import { translationDisplayText, displayTranslations, readingText, hoverTranslationText } from "../../documents/presentation.ts"
import type { DisplayTranslation } from "../../documents/presentation.ts"

interface DisplayUnit {
  readonly unit: DisplayTranslation
  readonly column: number
  readonly nextLine: number
  readonly text: string
}

class TranslationLens extends vscode.CodeLens {
  constructor(
    readonly document: vscode.TextDocument,
    readonly version: number,
    line: number
  ) {
    super(new vscode.Range(line, 0, line, 0))
  }
}

export class BrowseRenderer implements vscode.Disposable, vscode.CodeLensProvider {
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshLenses = false
  private disposed = false
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.changed.event
  private readonly contrast = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      textDecoration: "none; display: inline-block; position: relative; width: 0; top: -1.2em; font-size: 1em; line-height: 1em;"
    }
  })
  private readonly tail = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      textDecoration: "none; position: absolute; left: 0; top: 100%; width: 0; height: 1em; font-size: 1em; line-height: 1em; white-space: pre;"
    }
  })
  private readonly inplace = vscode.window.createTextEditorDecorationType({ textDecoration: "none; display: none;", before: { color: new vscode.ThemeColor("editor.foreground") } })
  private readonly subscriptions: vscode.Disposable[]
  private readonly loading: vscode.TextEditorDecorationType
  private readonly resolved = new Map<string, { version: number; lines: Set<number> }>()

  constructor(
    extensionUri: vscode.Uri,
    private readonly snapshot: (uri: vscode.Uri) => BrowseSnapshot | undefined
  ) {
    this.loading = vscode.window.createTextEditorDecorationType({
      after: {
        contentIconPath: vscode.Uri.joinPath(extensionUri, "dist/loading.svg"),
        width: "1em",
        height: "1em",
        textDecoration: "none; position: absolute; margin-left: 0.5em;"
      }
    })
    this.subscriptions = [
      vscode.languages.registerCodeLensProvider("*", this),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (displayMode(event.textEditor.document.uri) !== "inplace") return
        this.schedule(false)
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule(false)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (["editor.codeLens", "editor.fontSize", "editor.lineHeight", "editor.codeLensFontSize"].some((key) => event.affectsConfiguration(key))) {
          this.resolved.clear()
          this.render()
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.resolved.delete(document.uri.toString())
      })
    ]
  }

  private units(document: vscode.TextDocument, snapshot = this.snapshot(document.uri), ranges?: readonly { start: number; end: number }[]): DisplayUnit[] {
    if (snapshot?.version !== document.version) return []
    const units = ranges
      ? snapshot.units.filter((unit) => {
          const bounds = unit.display ?? unit
          return ranges.some((range) => bounds.start <= range.end && bounds.end >= range.start)
        })
      : snapshot.units
    const tabSize = Number(vscode.workspace.getConfiguration("editor", document.uri).get("tabSize", 4))
    return displayTranslations(document.getText(), units)
      .map((unit) => {
        const position = document.positionAt(unit.start)
        const first = unit.text.split(/\r?\n/, 1)[0]
        const stripped = unit.format === "yaml" ? first.trimStart() : readingText(first, { ...unit.source, text: first })
        const index = first.indexOf(stripped)
        const prefix = document.lineAt(position.line).text.slice(0, position.character) + first.slice(0, stripped && index >= 0 ? index : (first.match(/^\s*/)?.[0].length ?? 0))
        const column = [...prefix].reduce((column, character) => (character === "\t" ? column + tabSize - (column % tabSize) : column + 1), 0)
        return { unit, text: readingText(unit.translation, unit.candidate ? unit : unit.source), column, nextLine: document.positionAt(unit.end).line + 1 }
      })
      .filter((item) => !!item.text)
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (displayMode(document.uri) !== "contrast") return []
    const lines = new Set(
      this.units(document)
        .map((item) => item.nextLine)
        .filter((line) => line < document.lineCount)
    )
    return [...lines].map((line) => new TranslationLens(document, document.version, line))
  }

  resolveCodeLens(lens: vscode.CodeLens, token: vscode.CancellationToken): vscode.CodeLens | undefined {
    if (!(lens instanceof TranslationLens) || token.isCancellationRequested || lens.document.isClosed || lens.document.version !== lens.version) return
    const id = lens.document.uri.toString()
    const state = this.resolved.get(id)
    const resolved = state?.version === lens.version ? state : { version: lens.version, lines: new Set<number>() }
    resolved.lines.add(lens.range.start.line)
    this.resolved.set(id, resolved)
    lens.command = { title: " ", command: "" }
    this.schedule(false)
    return lens
  }

  render(): void {
    this.schedule(true)
  }

  private schedule(refreshLenses: boolean): void {
    if (this.disposed) return
    this.refreshLenses ||= refreshLenses
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const refresh = this.refreshLenses
      this.refreshLenses = false
      for (const editor of vscode.window.visibleTextEditors) this.paint(editor)
      if (refresh) this.changed.fire()
    }, 0)
  }

  edited(document: vscode.TextDocument, edits: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const id = document.uri.toString()
    const previous = this.resolved.get(id)
    if (!previous) return
    const lines = new Set<number>()
    if (previous.version === document.version - 1) {
      for (const line of previous.lines) {
        if (edits.some((edit) => edit.range.start.line < line && (edit.range.end.line > line || (edit.range.end.line === line && edit.range.end.character > 0)))) continue
        let shifted = line
        for (const edit of edits) {
          if (edit.range.end.line <= line) shifted += (edit.text.match(/\n/g)?.length ?? 0) - (edit.range.end.line - edit.range.start.line)
        }
        lines.add(shifted)
      }
    }
    this.resolved.set(id, { version: document.version, lines })
  }

  private paint(editor: vscode.TextEditor): void {
    const snapshot = this.snapshot(editor.document.uri)
    const document = editor.document
    const visible = editor.visibleRanges.map((range) => ({ start: document.offsetAt(range.start), end: document.offsetAt(document.lineAt(range.end.line).range.end) }))
    const lines =
      snapshot?.version === document.version
        ? [...new Set(snapshot.loading.filter((unit) => visible.some((range) => unit.end >= range.start && unit.end <= range.end)).map((unit) => document.positionAt(unit.end).line))]
        : []
    editor.setDecorations(
      this.loading,
      lines.map((line) => ({ range: new vscode.Range(editor.document.lineAt(line).range.end, editor.document.lineAt(line).range.end), hoverMessage: "正在翻译…" }))
    )
    // A contrast row can be visible while its source ends on the preceding line.
    const ranges = editor.visibleRanges.map((range, index) => ({ start: document.offsetAt(new vscode.Position(Math.max(0, range.start.line - 1), 0)), end: visible[index].end }))
    const units = this.units(document, snapshot, ranges)
    if (displayMode(editor.document.uri) === "inplace") {
      this.resolved.delete(editor.document.uri.toString())
      editor.setDecorations(this.contrast, [])
      editor.setDecorations(this.tail, [])
      editor.setDecorations(
        this.inplace,
        units.flatMap(({ unit }) => {
          const range = new vscode.Range(editor.document.positionAt(unit.start), editor.document.positionAt(unit.end))
          if (editor.selections.some((selection) => !!range.intersection(selection))) return []
          return [
            {
              range,
              hoverMessage: new vscode.MarkdownString().appendCodeblock(hoverTranslationText(unit.translation)),
              renderOptions: {
                before: {
                  contentText: unit.kind === "string" ? readingText(unit.translation, unit.source) : translationDisplayText(unit.translation, unit.format).replace(/\s*\r?\n\s*/g, " ")
                }
              }
            }
          ]
        })
      )
      return
    }
    editor.setDecorations(this.inplace, [])
    if (!vscode.workspace.getConfiguration("editor", editor.document.uri).get<boolean>("codeLens", true)) {
      editor.setDecorations(this.contrast, [])
      editor.setDecorations(this.tail, [])
      return
    }
    if (!units.length) this.resolved.delete(editor.document.uri.toString())
    const resolved = this.resolved.get(editor.document.uri.toString())
    const rows = new Map<number, DisplayUnit[]>()
    for (const item of units) {
      const { nextLine } = item
      if (nextLine < editor.document.lineCount && (resolved?.version !== editor.document.version || !resolved.lines.has(nextLine))) continue
      const row = rows.get(nextLine) ?? []
      row.push(item)
      rows.set(nextLine, row)
    }
    const contrast: vscode.DecorationOptions[] = []
    const tail: vscode.DecorationOptions[] = []
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end
    for (const [line, row] of rows) {
      if (line > editor.document.lineCount) continue
      const hoverMessage = new vscode.MarkdownString().appendCodeblock(row.map((item) => hoverTranslationText(item.unit.translation)).join("\n\n"))
      const content = { contentText: row.map((item) => item.text).join(" · "), textDecoration: `none; transform: translateX(${row[0].column}ch);` }
      if (line < editor.document.lineCount) contrast.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage, renderOptions: { before: content } })
      else tail.push({ range: new vscode.Range(end, end), hoverMessage, renderOptions: { after: content } })
    }
    editor.setDecorations(this.contrast, contrast)
    editor.setDecorations(this.tail, tail)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.resolved.clear()
    this.contrast.dispose()
    this.tail.dispose()
    this.inplace.dispose()
    this.loading.dispose()
    this.changed.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
