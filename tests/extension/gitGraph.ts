import * as vscode from "vscode"
import { automatic as automaticScope } from "../../src/host/configuration.ts"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runGitGraph(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  const folder = vscode.workspace.getWorkspaceFolder(workspace)
  assert(folder, "Missing Git Graph test workspace.")
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const graphConfig = vscode.workspace.getConfiguration("commentTranslatePlus", folder.uri)
  const previousAutomatic = config.inspect<boolean>("auto.enabled")?.globalValue
  const graphUri = (filePath: string, commit: string, repo = workspace.fsPath, exists = true) =>
    vscode.Uri.file("file.md").with({ scheme: "git-graph", query: Buffer.from(JSON.stringify({ filePath, commit, repo, exists })).toString("base64") })
  const graphOld = graphUri("docs/deleted-history.md", "previous")
  const graphNew = graphUri("docs/renamed-history.md", "current")
  const graphProvider = vscode.workspace.registerTextDocumentContentProvider("git-graph", {
    provideTextDocumentContent: (uri) => (uri.toString() === graphOld.toString() ? "Read the original document." : "Read the complete field.")
  })
  try {
    await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
    await graphConfig.update("auto.include", ["docs/**"], vscode.ConfigurationTarget.WorkspaceFolder)
    await vscode.commands.executeCommand("vscode.diff", graphOld, graphNew, "Historical document changes")
    const graphOriginal = await vscode.workspace.openTextDocument(graphOld)
    const graphModified = await vscode.workspace.openTextDocument(graphNew)
    await waitFor(
      () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === graphOld.toString())),
      "Git Graph historical diff tab"
    )
    assert(automaticScope(graphOriginal) && automaticScope(graphModified), "Git Graph historical diff did not resolve workspace paths on both virtual sides.")
    await waitFor(() => owner.browse.inspect(graphOld)?.status === "ready" && owner.browse.inspect(graphNew)?.status === "ready", "Git Graph historical sides automatically translate")
    assert(owner.browse.inspect(graphOld)!.units[0].translation.includes("阅读原始文档"), "Historical original did not translate its own content.")
    assert(owner.browse.inspect(graphNew)!.units[0].translation.includes("阅读完整字段"), "Historical modified did not translate its own content.")
    await graphConfig.update("auto.exclude", ["docs/deleted-history.md"], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => !owner.browse.has(graphOld) && owner.browse.inspect(graphNew)?.status === "ready", "renamed history uses each side's own path")
    await graphConfig.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => owner.browse.inspect(graphOld)?.status === "ready", "history exclusion clearing restarts original")
    owner.browse.stop(graphOld, true)
    await graphConfig.update("auto.include", ["**/*.md"], vscode.ConfigurationTarget.WorkspaceFolder)
    assert(!owner.browse.has(graphOld) && owner.browse.has(graphNew), "History scope change overrode a per-side manual stop.")
    assert(
      !graphOriginal.isDirty && !graphModified.isDirty && graphOriginal.getText() === "Read the original document." && graphModified.getText() === "Read the complete field.",
      "History translation edited source."
    )
    for (const invalid of [
      graphOld.with({ query: "invalid" }),
      graphUri("../docs/escape.md", "outside"),
      graphUri("docs/outside.md", "outside", vscode.Uri.joinPath(workspace, "..").fsPath),
      graphUri("docs/missing.md", "missing", workspace.fsPath, false)
    ]) {
      await vscode.commands.executeCommand("vscode.diff", invalid, graphNew, "Invalid history location")
      assert(!automaticScope(await vscode.workspace.openTextDocument(invalid)), "Invalid history location inherited an eligible peer's automatic scope.")
    }
    const standalone = await vscode.workspace.openTextDocument(graphUri("docs/standalone.md", "standalone"))
    assert(!automaticScope(standalone), "A historical document outside a diff inherited automatic scope.")
  } finally {
    await config.update("auto.enabled", previousAutomatic, vscode.ConfigurationTarget.Global)
    for (const key of ["auto.include", "auto.exclude"]) await graphConfig.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    graphProvider.dispose()
  }
  return ["Git Graph historical diff resolves both virtual sides to folder-scoped path rules, respects renamed paths and manual stops, rejects invalid locations and preserves source"]
}
