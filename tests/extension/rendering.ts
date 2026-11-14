import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { BrowseRenderer } from "../../src/features/browse/renderer.ts"
import type { BrowseSnapshot } from "../../src/features/browse/session.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

export async function runRendering(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const source = Array.from({ length: 240 }, (_, index) => `Read synthetic orchard paragraph ${index}.`).join("\n\n") + "\n"
  const uri = vscode.Uri.joinPath(workspace, "rendering-orchard.md")
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
  const document = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(document, { preview: false })
  const units = (await owner.documents.parse(document)).groups.flatMap((group) => group.units)
  let snapshot: BrowseSnapshot | undefined = {
    scope: "document",
    version: document.version,
    status: "working",
    total: units.length,
    pending: 1,
    failedUnits: [],
    loading: units,
    units: [],
    errors: []
  }
  const renderer = new BrowseRenderer(vscode.Uri.file(workspace.fsPath), (resource) => (resource.toString() === uri.toString() ? snapshot : undefined))
  let events = 0
  const changed = renderer.onDidChangeCodeLenses(() => events++)
  const token = new vscode.CancellationTokenSource()
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
  try {
    const translated = []
    for (const unit of units) {
      translated.push({ ...unit, translation: unit.text.replace("Read synthetic orchard paragraph", "阅读虚构果园段落") })
      snapshot = { ...snapshot!, loading: [], units: translated.slice() }
      renderer.render()
    }
    await tick()
    assert(events > 0 && events < units.length, "Per-unit completion flooded the native CodeLens provider with invalidations.")
    const lenses = renderer.provideCodeLenses(document)
    assert(lenses.length === units.length, "Viewport decoration filtering removed offscreen translation spacing.")
    const before = events
    for (const lens of lenses.slice(0, 30)) assert(renderer.resolveCodeLens(lens, token.token), "A current translated row could not be resolved.")
    await tick()
    assert(events === before, "Resolving visible translation rows invalidated CodeLenses again.")
    const last = lenses.at(-1)!
    editor.revealRange(last.range, vscode.TextEditorRevealType.AtTop)
    await tick()
    assert(renderer.resolveCodeLens(last, token.token), "An offscreen translation lost its spacing after scrolling into view.")
    assert(document.getText() === source && !document.isDirty, "Reading decorations changed the source document.")
    snapshot = undefined
    renderer.render()
    await tick()
    assert(renderer.provideCodeLenses(document).length === 0, "Stopped reading retained translation spacing.")
    const stopped = events
    renderer.render()
    renderer.dispose()
    renderer.render()
    await tick()
    assert(events === stopped, "A disposed renderer delivered a queued or late invalidation.")
  } finally {
    token.dispose()
    changed.dispose()
    renderer.dispose()
  }
  const checks = [
    "large-document result bursts coalesce native CodeLens invalidations while retaining offscreen spacing, scrolling and unchanged source",
    "CodeLens resolution does not invalidate itself and renderer disposal cancels queued refreshes"
  ]
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", uri)
  const previous = config.inspect("browse.translationScope")?.workspaceFolderValue
  const liveSource = Array.from({ length: 240 }, (_, index) => "Read the original document. `orchard-window-" + index + "`").join("\n\n")
  const liveUri = vscode.Uri.joinPath(workspace, "rendering-window.md")
  const control = async (hold: boolean) => {
    const response = await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold }) })
    assert(response.ok, "Could not control the synthetic HTTP service.")
  }
  const batchKeys = [
    "request.maxItems",
    "request.initialItems",
    "request.adaptiveBatching",
    "request.batchBySemanticScope",
    "request.includeContext",
    "request.maxCharacters",
    "request.initialCharacters"
  ]
  const previousBatch = batchKeys.map((key) => config.inspect(key)?.globalValue)
  try {
    await config.update("browse.translationScope", "document", vscode.ConfigurationTarget.WorkspaceFolder)
    await vscode.workspace.fs.writeFile(liveUri, new TextEncoder().encode(liveSource))
    const live = await vscode.workspace.openTextDocument(liveUri)
    const liveEditor = await vscode.window.showTextDocument(live, { preview: false })
    await control(true)
    await owner.browse.start(live)
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 15000
      while (!check()) {
        assert(Date.now() < deadline, "Whole-document preparation window did not reach the expected state.")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    await waitFor(() => owner.translations.progress(liveUri).current > 0)
    const initial = owner.browse.inspect(liveUri)!
    assert(initial.loading.length > 0 && initial.loading.length < initial.total, "The desktop reading path submitted the whole document before its first response.")
    const tail = (await owner.documents.parse(live)).groups.flatMap((group) => group.units).at(-1)!
    const position = live.positionAt(tail.start)
    liveEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop)
    await waitFor(() => owner.browse.inspect(liveUri)!.loading.some((unit) => unit.id === tail.id))
    await control(false)
    await waitFor(() => owner.browse.inspect(liveUri)?.status === "ready")
    const completed = owner.browse.inspect(liveUri)!
    assert(completed.units.length === completed.total && completed.units.length === 240, "Bounded preparation did not automatically finish the document tail.")
    assert(completed.loading.length === 0 && live.getText() === liveSource && !live.isDirty, "Document completion retained loading or changed source.")
    owner.browse.stop(liveUri, true)
    checks.push("official desktop HTTP fills a bounded document tail, admits a distant viewport during a held request and completes all units without editing source")
    const records = async () => ((await (await fetch(origin + "/state")).json()) as { requests: { count: number }[] }).requests
    const beforeLarge = (await records()).length
    for (const [index, value] of [180, 180, false, false, false, 200000, 200000].entries()) await config.update(batchKeys[index], value, vscode.ConfigurationTarget.Global)
    const largeUri = vscode.Uri.joinPath(workspace, "rendering-large-batch.md")
    await vscode.workspace.fs.writeFile(largeUri, new TextEncoder().encode(liveSource.replaceAll("orchard-window-", "orchard-large-batch-")))
    const large = await vscode.workspace.openTextDocument(largeUri)
    try {
      // Keep this document hidden so viewport priority does not split the batch.
      await owner.browse.start(large)
      await waitFor(() => owner.browse.inspect(largeUri)?.status === "ready")
      assert(owner.browse.inspect(largeUri)?.units.length === 240, "A larger configured batch lost document results.")
      assert(
        (await records()).slice(beforeLarge).some((record) => record.count === 180),
        "Preparation imposed a smaller batch cap than the configured HTTP target."
      )
      checks.push("a larger configured HTTP batch remains reachable through bounded document preparation")
    } finally {
      owner.browse.stop(largeUri, true)
    }
  } finally {
    owner.browse.stop(liveUri, true)
    await control(false)
    await config.update("browse.translationScope", previous, vscode.ConfigurationTarget.WorkspaceFolder)
    for (const [index, value] of previousBatch.entries()) await config.update(batchKeys[index], value, vscode.ConfigurationTarget.Global)
  }
  console.log("Document browse performance: bounded HTTP preparation, complete results, coalesced CodeLens refresh, scrolling and disposal passed.")
  return checks
}
