import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

export async function runBackgroundRules(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", workspace)
  const settings = {
    profiles: [{ id: "background-rules", provider: "openai", apiUrl: origin + "/public/v1/chat/completions", model: "background-rules", apiKey: "" }],
    activeProfile: "background-rules",
    targetLanguage: "zh-CN",
    "auto.enabled": false,
    "auto.include": ["background-scope/**/*.md", "background-scope/readme.md", "background-scope/nested/**"],
    "auto.exclude": ["**/blocked.md"],
    persistentCache: false,
    preserveTerms: [],
    skipSameLanguage: false,
    maxRequestsPerSecond: 100
  }
  const target = (key: string) => (key === "auto.include" || key === "auto.exclude" ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global)
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, target(key) === vscode.ConfigurationTarget.WorkspaceFolder ? config.inspect(key)?.workspaceFolderValue : config.inspect(key)?.globalValue])
  )
  const sources = [
    ["background-scope/readme.md", "Read the original document. WorkspaceRulesFirst."],
    ["background-scope/nested/note.md", "Read the original document. WorkspaceRulesSecond."],
    ["background-scope/nested/blocked.md", "Read the original document. WorkspaceRulesExcluded."],
    ["background-scope/unselected.txt", "Read the original document. WorkspaceRulesUnselected."],
    ["background-outside.md", "Read the original document. WorkspaceRulesOutside."]
  ] as const
  for (const [file, source] of sources) {
    const uri = vscode.Uri.joinPath(workspace, file)
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."))
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
  }
  const opened = new Set<string>()
  const observed = vscode.workspace.onDidOpenTextDocument((document) => opened.add(document.uri.toString()))
  const requests = async () => {
    const state = (await (await fetch(origin + "/state")).json()) as { requests: { model: string; count: number }[] }
    return state.requests.filter((item) => item.model === "background-rules")
  }
  const control = async (value: object) => {
    const response = await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) })
    assert(response.ok, "Background mock control failed.")
  }
  try {
    for (const document of vscode.workspace.textDocuments) owner.browse.stop(document.uri, false)
    for (const [key, value] of Object.entries(settings)) await config.update(key, value, target(key))
    await control({ hold: true })
    const heldBefore = (await requests()).length
    const pending = vscode.commands.executeCommand("commentTranslatePlus.translateWorkspace")
    try {
      const deadline = Date.now() + 10000
      while ((await requests()).length === heldBefore) {
        assert(Date.now() < deadline, "Background translation did not start its first request.")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const visited = sources.slice(0, 2).filter(([file]) => opened.has(vscode.Uri.joinPath(workspace, file).toString()))
      assert(visited.length === 1, "Background pre-parsed later files before the first translation completed.")
      await vscode.commands.executeCommand("commentTranslatePlus.cancel")
    } finally {
      await control({ hold: false })
      await pending
    }
    assert(!owner.background.isRunning, "The shared cancel command left background work running.")
    const before = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.translateWorkspace")
    const sent = (await requests()).slice(before)
    assert(
      sent.reduce((count, item) => count + item.count, 0) === 2,
      "Background translation ignored include/exclude rules or repeated overlapping matches: " + JSON.stringify({ sent, opened: [...opened] })
    )
    for (const [index, [file, source]] of sources.entries()) {
      const uri = vscode.Uri.joinPath(workspace, file)
      assert(opened.has(uri.toString()) === index < 2, "Background discovery opened a file outside its include/exclude scope: " + file)
      if (index < 2) {
        const document = await vscode.workspace.openTextDocument(uri)
        assert(document.getText() === source && !document.isDirty && !owner.browse.has(uri), "Background translation changed source or created a browse session.")
      }
    }
    await config.update("auto.include", [], vscode.ConfigurationTarget.WorkspaceFolder)
    opened.clear()
    const after = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.translateWorkspace")
    assert((await requests()).length === after && opened.size === 0, "Empty includes still opened or translated workspace files.")
  } finally {
    await control({ hold: false })
    observed.dispose()
    for (const [key, value] of Object.entries(previous)) await config.update(key, value, target(key))
  }
  return [
    "workspace translation starts HTTP before opening later files and the shared cancel command stops the remaining scan",
    "workspace background translation applies folder include/exclude rules before opening files, excludes win and overlapping includes submit each source once",
    "workspace background translation accepts an empty include list without opening files or sending requests, and remains independent of automatic browse"
  ]
}
