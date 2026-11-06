import assert from "node:assert/strict"
import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { replacementIdentity } from "../../src/features/replacement.ts"

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runMerge(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", workspace)
  const previousAutomatic = config.inspect<boolean>("auto.enabled")?.globalValue
  const previous = Object.fromEntries(["auto.include", "auto.exclude"].map((key) => [key, config.inspect(key)?.workspaceFolderValue]))
  const root = vscode.Uri.joinPath(workspace, "merge-fixture")
  await vscode.workspace.fs.createDirectory(root)
  const documents: vscode.TextDocument[] = []
  for (const [name, text] of [
    ["base", "Read the original document. MergeBase."],
    ["left", "Read the complete field. MergeLeft."],
    ["right", "Keep both lines together. MergeRight."],
    ["result", "Read the original document. MergeResult."],
    ["ordinary", "Read the complete field. OrdinaryPane."]
  ]) {
    const uri = vscode.Uri.joinPath(root, name + ".md")
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
    documents.push(await vscode.workspace.openTextDocument(uri))
  }
  const [base, left, right, result, ordinary] = documents
  const sources = documents.map((document) => document.getText())
  const requests = async (): Promise<{ cancelled: boolean }[]> => ((await (await fetch(origin + "/state")).json()) as { requests: { cancelled: boolean }[] }).requests
  const control = async (hold: boolean) => {
    const response = await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold }) })
    assert.ok(response.ok)
  }
  const openMerge = () => vscode.commands.executeCommand("_open.mergeEditor", { base: base.uri, input1: left.uri, input2: right.uri, output: result.uri })
  try {
    await config.update("auto.enabled", false, vscode.ConfigurationTarget.Global)
    await config.update("auto.include", ["merge-fixture/**"], vscode.ConfigurationTarget.WorkspaceFolder)
    await config.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    const editor = await vscode.window.showTextDocument(result, { preview: false })
    const identity = await replacementIdentity(result.uri, owner.translations)
    const snapshot = { uri: result.uri.toString(), version: result.version, start: 0, end: sources[3].length, source: sources[3], text: "阅读原始文档。 MergeResult.", identity }
    const before = (await requests()).length
    await control(true)
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(async () => (await requests()).length > before, "ordinary editor starts held translation")
    await openMerge()
    await waitFor(() => !owner.browse.has(result.uri), "merge editor cancels existing browse")
    await waitFor(async () => (await requests())[before].cancelled, "merge editor cancels held HTTP")
    await control(false)
    await vscode.commands.executeCommand("merge.showBase")
    await waitFor(() => vscode.window.visibleTextEditors.some((editor) => editor.document === base), "merge base becomes visible")
    await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
    const afterOpen = (await requests()).length
    for (const document of [base, left, right, result]) {
      assert.ok(
        vscode.window.visibleTextEditors.some((editor) => editor.document === document),
        "Merge pane must be visible in the real host"
      )
      assert.equal(owner.documents.supports(document), false, "Merge pane must be excluded")
      const token = new vscode.CancellationTokenSource()
      try {
        assert.equal(await owner.hover.provideHover(document, new vscode.Position(0, 5), token.token), undefined)
      } finally {
        token.dispose()
      }
      await owner.browse.start(document)
      await owner.preview.open(document)
      await owner.retranslate(document)
      assert.equal(owner.browse.has(document.uri), false)
      assert.equal(owner.preview.has(document.uri), false)
    }
    assert.equal(vscode.window.activeTextEditor?.document, result)
    vscode.window.activeTextEditor!.selection = new vscode.Selection(0, 0, 0, sources[3].length)
    for (const command of ["toggleDocumentBrowseMode", "toggleDocumentBrowseMode.active", "translateAll", "retranslate", "retranslateBlock", "retry", "translateAndReplace", "preview"]) {
      await vscode.commands.executeCommand("commentTranslatePlus." + command)
    }
    assert.equal(await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", snapshot), false, "An old hover replacement must not edit a merge result")
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal((await requests()).length, afterOpen, "Merge translation entry points must remain offline")
    await vscode.commands.executeCommand("commentTranslatePlus.translateWorkspace")
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The global background command may process the ordinary file, while every
    // visible merge pane remains excluded from requests and presentation.
    assert.equal(owner.browse.has(result.uri), false)
    for (const document of [base, left, right, result]) assert.equal(owner.preview.has(document.uri), false)
    assert.equal((await requests()).slice(afterOpen).length, 1, "Only the ordinary background file may translate")
    documents.forEach((document, index) => assert.equal(document.getText(), sources[index], "Merge operations changed source"))
    assert.ok(!result.isDirty)
    await vscode.window.showTextDocument(ordinary.uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })
    await waitFor(() => owner.browse.inspect(ordinary.uri)?.status === "ready", "ordinary sibling editor remains supported beside merge")
    assert.equal(owner.documents.supports(result), false, "An ordinary sibling must not enable merge panes")
    assert.equal(owner.browse.has(result.uri), false)
    await vscode.window.showTextDocument(result.uri, { viewColumn: vscode.ViewColumn.Three, preview: false })
    assert.equal(owner.documents.supports(vscode.window.activeTextEditor!.document), false, "A second view of the merge result must remain excluded")
    assert.equal(owner.browse.has(result.uri), false)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.window.showTextDocument(result.uri, { preview: false })
    await waitFor(() => owner.browse.inspect(result.uri)?.status === "ready", "ordinary editor restores automatic translation")
    assert.ok(owner.documents.supports(vscode.window.activeTextEditor!.document))
    assert.ok(!editor.document.isDirty)
  } finally {
    await control(false)
    for (const document of documents) owner.browse.stop(document.uri, false)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.commands.executeCommand("workbench.action.joinAllGroups")
    await config.update("auto.enabled", previousAutomatic, vscode.ConfigurationTarget.Global)
    for (const [key, value] of Object.entries(previous)) await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder)
  }
  return [
    "merge editor panes reject automatic reading, translation commands, hover, preview, selection replacement and old hover edits while preserving source",
    "opening a merge editor cancels its existing browse HTTP consumer and ordinary editors resume automatic translation after closing it"
  ]
}
