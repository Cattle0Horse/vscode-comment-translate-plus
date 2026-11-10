import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { automatic } from "../../src/host/configuration.ts"
import type { Application } from "../../src/host/application.ts"

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runFileRules(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  const root = vscode.Uri.joinPath(workspace, "file-rule-repository")
  const old = vscode.Uri.joinPath(root, "docs", "before.md")
  const current = vscode.Uri.joinPath(root, "docs", "rule[1]{a,b}.md")
  const deleted = vscode.Uri.joinPath(root, "docs", "deleted.md")
  const source = "Read the original document."
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root.fsPath })
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "docs"))
  await vscode.workspace.fs.writeFile(old, new TextEncoder().encode(source))
  await vscode.workspace.fs.writeFile(deleted, new TextEncoder().encode(source))
  await git("init")
  await git("add", ".")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Fixture")
  await vscode.workspace.fs.rename(old, current)
  await vscode.workspace.fs.delete(deleted)
  await git("add", "--all")
  const gitExtension = vscode.extensions.getExtension("vscode.git")!
  const api = (await gitExtension.activate()).getAPI(1) as {
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
    openRepository(uri: vscode.Uri): Promise<unknown>
  }
  assert.ok(await api.openRepository(root))
  const before = api.toGitUri(old, "HEAD")
  const after = api.toGitUri(current, "")
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", workspace)
  const previous = Object.fromEntries(["auto.enabled", "auto.include", "auto.exclude"].map((key) => [key, config.inspect(key)]))
  const diffConfig = vscode.workspace.getConfiguration("diffEditor")
  const previousDiff = Object.fromEntries(["renderSideBySide", "useInlineViewWhenSpaceIsLimited"].map((key) => [key, diffConfig.inspect(key)?.globalValue]))
  const graphUri = (filePath: string, exists = true, repo = root.fsPath) =>
    vscode.Uri.file("file.md").with({ scheme: "git-graph", query: Buffer.from(JSON.stringify({ filePath, commit: "fixture", repo, exists })).toString("base64") })
  const graphBefore = graphUri("docs/before.md")
  const graphAfter = graphUri("docs/rule[1]{a,b}.md")
  const empty = graphUri("docs/deleted.md", false)
  const provider = vscode.workspace.registerTextDocumentContentProvider("git-graph", { provideTextDocumentContent: (uri) => (uri.toString() === empty.toString() ? "" : source) })
  const virtualProvider = vscode.workspace.registerTextDocumentContentProvider("ctp-file-rule", { provideTextDocumentContent: () => source })
  const documents = new Set<vscode.TextDocument>()
  const previousStatus = (await git("status", "--porcelain")).stdout
  const checks: string[] = []
  const expected = "file-rule-repository/docs/rule[[]1[]][{]a,b[}].md"

  async function addRule(uri: vscode.Uri, pattern: string, text = source): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri)
    documents.add(document)
    for (const kind of ["include", "exclude"]) {
      const key = "auto." + kind
      await config.update(key, [], vscode.ConfigurationTarget.WorkspaceFolder)
      await vscode.commands.executeCommand("commentTranslatePlus.auto." + kind + "CurrentFile")
      assert.deepEqual(
        config.inspect<string[]>(key)?.workspaceFolderValue,
        [pattern],
        `The ${kind} command must append the resolved file path for ${uri.scheme}, not its display path or the focused old revision`
      )
    }
    assert.equal(document.getText(), text)
    assert.equal(document.isDirty, false)
  }

  async function openDiff(original: vscode.Uri, modified: vscode.Uri, inline: boolean, viewColumn = vscode.ViewColumn.One): Promise<void> {
    await diffConfig.update("renderSideBySide", !inline, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand("vscode.diff", original, modified, "File rule fixture", { preview: false, viewColumn })
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
      return input instanceof vscode.TabInputTextDiff && input.original.toString() === original.toString() && input.modified.toString() === modified.toString()
    }, "file rule diff opens")
  }

  try {
    await config.update("auto.enabled", false, vscode.ConfigurationTarget.Global)
    await diffConfig.update("useInlineViewWhenSpaceIsLimited", false, vscode.ConfigurationTarget.Global)
    const history = await vscode.workspace.openTextDocument(before.with({ path: before.path + ".git" }))
    await vscode.window.showTextDocument(history, { preview: false })
    await addRule(history.uri, "file-rule-repository/docs/before.md")
    await vscode.window.showTextDocument(api.toGitUri(deleted, "HEAD"), { preview: false })
    await addRule(api.toGitUri(deleted, "HEAD"), "file-rule-repository/docs/deleted.md")
    await vscode.window.showTextDocument(graphAfter, { preview: false })
    await addRule(graphAfter, expected)
    checks.push("current-file rules resolve standalone Git and Git Graph history, including deleted files and Git display paths ending in .git")

    for (const [original, modified] of [
      [before, after],
      [graphBefore, graphAfter],
      [before, current]
    ]) {
      for (const inline of [false, true]) {
        await openDiff(original, modified, inline)
        if (!inline) {
          await vscode.commands.executeCommand("workbench.action.compareEditor.focusSecondarySide")
          await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === original.toString(), "old diff side focused")
        }
        await addRule(modified, expected)
        assert.equal(automatic(await vscode.workspace.openTextDocument(current)), false, "Adding a rule must not enable automatic translation")
      }
    }
    checks.push("Git and Git Graph inline and side-by-side diffs use the modified path even when a renamed original has focus; literal glob characters remain escaped")

    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.window.showTextDocument(current, { viewColumn: vscode.ViewColumn.One, preview: false })
    await vscode.window.showTextDocument(history, { viewColumn: vscode.ViewColumn.Two, preview: false })
    await openDiff(graphBefore, graphAfter, false, vscode.ViewColumn.Three)
    assert.equal(vscode.window.tabGroups.all.length, 3)
    await vscode.commands.executeCommand("workbench.action.compareEditor.focusSecondarySide")
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === graphBefore.toString(), "third column old side focused")
    await addRule(graphAfter, expected)
    checks.push("current-file rules follow the active diff in a three-column window rather than another visible editor")

    await openDiff(graphUri("docs/deleted.md"), empty, true)
    await addRule(empty, "file-rule-repository/docs/deleted.md", "")
    await config.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
    assert.equal(automatic(await vscode.workspace.openTextDocument(empty)), false, "An empty historical side must not become automatically eligible")
    await config.update("auto.enabled", false, vscode.ConfigurationTarget.Global)

    for (const invalid of [
      graphAfter.with({ query: "invalid" }),
      graphUri("../escape.md"),
      graphUri(current.fsPath),
      graphUri("outside.md", true, vscode.Uri.joinPath(workspace, "..").fsPath),
      after.with({ query: "invalid" }),
      after.with({ query: JSON.stringify({ path: "relative.md", ref: "HEAD" }) }),
      after.with({ query: JSON.stringify({ path: current.fsPath }) }),
      vscode.Uri.parse("ctp-file-rule:/unknown.md")
    ]) {
      await openDiff(graphBefore, invalid, true)
      for (const kind of ["include", "exclude"]) {
        const key = "auto." + kind
        const saved = config.inspect<string[]>(key)?.workspaceFolderValue
        await vscode.commands.executeCommand("commentTranslatePlus.auto." + kind + "CurrentFile")
        assert.deepEqual(config.inspect<string[]>(key)?.workspaceFolderValue, saved, "Unresolvable modified paths must not write rules or fall back to the original")
      }
    }
    checks.push(
      "Git Graph empty sides can add path rules without enabling empty-body translation; malformed, escaping, absolute, outside-workspace and unrelated virtual paths cannot write rules"
    )

    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.commands.executeCommand("workbench.action.joinAllGroups")
    await vscode.commands.executeCommand("_open.mergeEditor", { base: before, input1: after, input2: graphAfter, output: current })
    await vscode.commands.executeCommand("merge.columnLayout")
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === current.toString(), "merge result focused")
    await addRule(current, expected)
    await config.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
    const merged = vscode.window.activeTextEditor!.document
    assert.equal(owner.documents.supports(merged), false, "Adding rules must preserve merge translation exclusion")
    assert.equal(owner.browse.has(current), false)
    checks.push("three-way merge result supports current-file rules while merge panes remain excluded from translation")

    for (const document of documents) assert.equal(document.isDirty, false)
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(current)), source)
    assert.equal((await git("status", "--porcelain")).stdout, previousStatus, "Adding rules changed the Git index or working copy")
    for (const key of ["auto.include", "auto.exclude"]) assert.deepEqual(config.inspect(key)?.globalValue, previous[key]?.globalValue)
  } finally {
    await config.update("auto.enabled", false, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.commands.executeCommand("workbench.action.joinAllGroups")
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "auto.enabled") await config.update(key, value?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder)
      await config.update(key, value?.globalValue, vscode.ConfigurationTarget.Global)
    }
    for (const [key, value] of Object.entries(previousDiff)) await diffConfig.update(key, value, vscode.ConfigurationTarget.Global)
    provider.dispose()
    virtualProvider.dispose()
  }
  return checks
}
