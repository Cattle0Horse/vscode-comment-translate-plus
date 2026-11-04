import * as vscode from "vscode"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { automatic } from "../../src/host/configuration.ts"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runStaged(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  const root = vscode.Uri.joinPath(workspace, "staged-repository")
  await vscode.workspace.fs.createDirectory(root)
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root.fsPath })
  const file = vscode.Uri.joinPath(root, "docs", "staged.md")
  const stagedDeletion = vscode.Uri.joinPath(root, "docs", "staged-deleted.md")
  const unstagedDeletion = vscode.Uri.joinPath(root, "docs", "unstaged-deleted.md")
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "docs"))
  const write = (text: string) => vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text))
  await git("init")
  await write("Read the original document.")
  await vscode.workspace.fs.writeFile(stagedDeletion, new TextEncoder().encode("Read the original document."))
  await vscode.workspace.fs.writeFile(unstagedDeletion, new TextEncoder().encode("Read the complete field."))
  await git("add", ".")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Fixture")
  await write("Read the complete field.")
  await git("add", ".")
  await write("Unstaged working copy stays separate.")
  await vscode.workspace.fs.delete(stagedDeletion)
  await vscode.workspace.fs.delete(unstagedDeletion)
  await git("add", "--", "docs/staged-deleted.md")
  const extension = vscode.extensions.getExtension("vscode.git")
  assert(extension, "Missing built-in Git extension.")
  const api = (await extension.activate()).getAPI(1) as {
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
    openRepository(uri: vscode.Uri): Promise<{ status(): Promise<void> } | null>
  }
  const repository = await api.openRepository(root)
  assert(repository, "Missing fixture repository.")
  const original = api.toGitUri(file, "HEAD")
  const staged = api.toGitUri(file, "")
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", workspace)
  const previousAutomatic = config.inspect<boolean>("auto.enabled")?.globalValue
  try {
    await config.update("auto.include", ["staged-repository/docs/**"], vscode.ConfigurationTarget.WorkspaceFolder)
    await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand("vscode.diff", original, staged, "Staged changes")
    const before = await vscode.workspace.openTextDocument(original)
    const after = await vscode.workspace.openTextDocument(staged)
    await waitFor(
      () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === staged.toString())),
      "staged diff tab"
    )
    assert(automatic(before) && automatic(after), "Staged Git diff did not match workspace automatic rules.")
    await waitFor(() => owner.browse.inspect(original)?.status === "ready" && owner.browse.inspect(staged)?.status === "ready", "staged diff translation")
    assert(owner.browse.inspect(original)!.units[0].translation.includes("阅读原始文档"), "HEAD content was not translated.")
    assert(owner.browse.inspect(staged)!.units[0].translation.includes("阅读完整字段"), "Index content was not translated.")
    await config.update("auto.exclude", ["staged-repository/docs/**"], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => !owner.browse.has(original) && !owner.browse.has(staged), "staged exclusion")
    await config.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => owner.browse.inspect(original)?.status === "ready" && owner.browse.inspect(staged)?.status === "ready", "staged inclusion restored")
    owner.browse.stop(original, true)
    await config.update("auto.include", ["**/*.md"], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => owner.browse.inspect(staged)?.status === "ready", "staged manual override")
    assert(!owner.browse.has(original), "Automatic scope overrode manual stop on HEAD.")
    assert(before.getText() === "Read the original document." && after.getText() === "Read the complete field." && !before.isDirty && !after.isDirty, "Git source was edited.")
    assert(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)) === "Unstaged working copy stays separate.", "Working copy was edited.")
    const standalone = await vscode.workspace.openTextDocument(api.toGitUri(file, "HEAD~0"))
    assert(automatic(standalone), "Standalone Git revision did not resolve its workspace path.")
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await repository.status()
    const previousStatus = (await git("status", "--porcelain")).stdout
    for (const [deleted, translation] of [
      [stagedDeletion, "阅读原始文档"],
      [unstagedDeletion, "阅读完整字段"]
    ] as const) {
      await vscode.commands.executeCommand("git.openChange", deleted)
      const revision = api.toGitUri(deleted, "HEAD")
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === revision.toString(), "deleted file opens its Git revision")
      const document = vscode.window.activeTextEditor!.document
      assert(
        vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === revision.toString())),
        "Deleted file did not open as an individual historical document."
      )
      assert(automatic(document), "Deleted Git file did not match workspace automatic rules.")
      await waitFor(() => owner.browse.inspect(revision)?.status === "ready", "deleted file automatic translation")
      assert(owner.browse.inspect(revision)!.units[0].translation.includes(translation), "Deleted file revision was not translated.")
      assert(!document.isDirty, "Deleted file revision was edited.")
    }
    await config.update("auto.exclude", ["**/*-deleted.md"], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => !owner.browse.has(api.toGitUri(stagedDeletion, "HEAD")) && !owner.browse.has(api.toGitUri(unstagedDeletion, "HEAD")), "deleted files excluded")
    await config.update("auto.exclude", [], vscode.ConfigurationTarget.WorkspaceFolder)
    await waitFor(() => owner.browse.inspect(api.toGitUri(unstagedDeletion, "HEAD"))?.status === "ready", "visible deleted file restored")
    owner.browse.stop(api.toGitUri(unstagedDeletion, "HEAD"), true)
    await config.update("auto.include", ["staged-repository/docs/**"], vscode.ConfigurationTarget.WorkspaceFolder)
    assert(!owner.browse.has(api.toGitUri(unstagedDeletion, "HEAD")), "Deleted file manual stop was overridden.")
    assert((await git("status", "--porcelain")).stdout === previousStatus, "Deleted files or index were changed by translation.")
  } finally {
    await config.update("auto.enabled", previousAutomatic, vscode.ConfigurationTarget.Global)
    for (const key of ["auto.include", "auto.exclude"]) await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  }
  return [
    "built-in Git HEAD/index diff automatically translates each revision under folder rules, respects exclusions and manual stops, and preserves index and working copy",
    "built-in Git opens staged and unstaged deletions as individual historical documents that automatically translate under path rules without restoring or editing files"
  ]
}
