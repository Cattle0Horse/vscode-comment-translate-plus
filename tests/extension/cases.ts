import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { translationDisplayText } from "../../src/documents/presentation.ts"

interface HostCase {
  readonly id: string
  readonly file: string
  readonly languageId: string
  readonly units: number
  readonly anchorLines?: readonly number[]
  readonly contains?: readonly string[]
  readonly excludes?: readonly string[]
  readonly error?: string
  readonly eol?: "crlf"
  readonly visitLines?: readonly number[]
  readonly strings?: boolean
}

export interface HostCaseResult {
  readonly id: string
  readonly file: string
  readonly units: number
  readonly errors: readonly string[]
  readonly requests: number
  readonly sourceUnchanged: boolean
  readonly cacheReused: boolean
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw Error(`Host case timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runHostCases(workspace: vscode.Uri, controller: Application, requestCount: () => Promise<number>): Promise<HostCaseResult[]> {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  await config.update("maxItemsPerRequest", 20, vscode.ConfigurationTarget.Global)
  const cases = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, "host-cases.json")))) as HostCase[]
  const evidence: HostCaseResult[] = []
  for (const item of cases) {
    await config.update("browse.strings", item.strings ?? false, vscode.ConfigurationTarget.Global)
    const uri = vscode.Uri.joinPath(workspace, "examples", item.file)
    const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
    let document = await vscode.workspace.openTextDocument(uri)
    if (document.languageId !== item.languageId) document = await vscode.languages.setTextDocumentLanguage(document, item.languageId)
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document === document, item.id + " focus")
    const before = await requestCount()
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const targets = (await controller.documents.parse(document)).groups.flatMap((group) => group.units)
    const visitAll = async (): Promise<void> => {
      for (const unit of targets) {
        const position = document.positionAt(unit.start)
        if (!editor.visibleRanges.some((range) => range.contains(position))) editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop)
        await waitFor(() => editor.visibleRanges.some((range) => range.contains(position)), item.id + " unit visibility")
        await waitFor(() => controller.browse.inspect(uri)?.units.some((translated) => translated.id === unit.id) ?? false, item.id + " visible unit completion")
      }
    }
    await visitAll()
    for (const line of item.visitLines ?? []) {
      const position = new vscode.Position(line, 0)
      const offset = document.offsetAt(position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop)
      await waitFor(() => editor.visibleRanges.some((range) => range.contains(position)), item.id + " scroll visibility")
      await waitFor(() => controller.browse.inspect(uri)?.units.some((unit) => unit.start <= offset && unit.end > offset) ?? false, item.id + " visible batch")
    }
    await waitFor(() => {
      const snapshot = controller.browse.inspect(uri)
      return snapshot?.pending === 0 && snapshot.units.length === item.units
    }, item.id + " translated units")
    const snapshot = controller.browse.inspect(uri)!
    assert(snapshot.status === (item.error ? "error" : "ready"), item.id + ": unexpected completion status")
    assert(JSON.stringify(snapshot.errors) === JSON.stringify(item.error ? [item.error] : []), item.id + ": unexpected rejection")
    assert(document.getText() === original && !document.isDirty, item.id + ": browse modified the source")
    assert(new Set(snapshot.units.map((unit) => unit.id)).size === item.units, item.id + ": repeated unit identity")
    for (const unit of snapshot.units) {
      assert(original.slice(unit.start, unit.end) === unit.text, item.id + ": source offsets no longer match")
      let expected = (unit.content ?? unit.text)
        .replace("Read the complete field.", "阅读完整字段。")
        .replace("Keep both lines together.", "保留两行在一起。")
        .replace("Keep its context.", "保留其上下文。")
        .replace("Read the original document.", "阅读原始文档。")
        .replace("Keep ", "保留 ")
        .replace(" and ", " 和 ")
        .replace(/^(\s*)data-analysis(\s*)$/, "$1数据分析$2")
        .replace(/^(\s*)active(\s*)$/, "$1可用的$2")
        .replace(
          /^(\s*(?:-\s+)?)(description|name|notes|metadata|label|hints|enabled|priority|count|meta|tags|default_enabled|availability|read_only|required)(?=\s*:|\s*$)/gm,
          (_match, prefix: string, key: string) =>
            prefix +
            (
              {
                description: "描述",
                name: "名称",
                notes: "备注",
                metadata: "元数据",
                label: "标签",
                hints: "提示",
                enabled: "启用",
                priority: "优先级",
                count: "数量",
                meta: "元信息",
                tags: "标签",
                default_enabled: "默认启用",
                availability: "可用性",
                read_only: "只读",
                required: "必需"
              } as Record<string, string>
            )[key]
        )
      if (expected !== (unit.content ?? unit.text) && (unit.content !== undefined || unit.format === "markdown" || unit.kind === "string"))
        expected = expected.replace(/[\t ]*(?:\r\n|[\r\n])(?:[\t >]*(?:\r\n|[\r\n]))*[\t >]*/gu, " ")
      const actual = unit.content === undefined ? unit.translation : unit.translation === unit.text ? unit.content : translationDisplayText(unit.translation, "yaml")
      assert(actual === expected, item.id + ": reordered HTTP results crossed unit identities: " + JSON.stringify({ original: unit.text, actual, expected }))
    }
    for (const field of item.contains ?? [])
      assert(
        snapshot.units.some((unit) => unit.text.includes(field) || unit.content?.includes(field)),
        item.id + ": complete field or continuation was split"
      )
    for (const code of item.excludes ?? []) assert(!snapshot.units.some((unit) => unit.text.includes(code)), item.id + ": protected content was translated")
    if (item.anchorLines)
      assert(JSON.stringify(snapshot.units.map((unit) => document.positionAt(unit.start).line)) === JSON.stringify(item.anchorLines), item.id + ": paragraph anchors merged")
    if (item.eol === "crlf") assert(document.eol === vscode.EndOfLine.CRLF && original.includes("\r\n"), item.id + ": lost CRLF coverage")
    const translatedRequests = await requestCount()
    if (item.units === 0) assert(translatedRequests === before, item.id + ": nontranslatable input reached the service")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await visitAll()
    await waitFor(() => {
      const current = controller.browse.inspect(uri)
      return current?.pending === 0 && current.status === snapshot.status && (item.units === 0 || current.units.length > 0)
    }, item.id + " cache restore")
    assert((await requestCount()) === translatedRequests, item.id + ": toggling requested cached content again")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
    evidence.push({ id: item.id, file: item.file, units: snapshot.units.length, errors: snapshot.errors, requests: translatedRequests - before, sourceUnchanged: true, cacheReused: true })
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  return evidence
}
