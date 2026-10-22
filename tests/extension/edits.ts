import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { markdownPreviewUri } from "../../src/features/preview.ts"
import { previewLoadingMarker } from "../../src/documents/presentation.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error("Timed out: " + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runEditReuse(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const checks: string[] = []
  const records = async () => ((await (await fetch(origin + "/state")).json()) as { requests: { count: number }[] }).requests
  const uri = vscode.Uri.joinPath(workspace, "incremental-preview.md")
  const source = "Read the original document.\n\nKeep its context."
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
  const document = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(document, { preview: false })
  const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(uri))
  const previewText = async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(preview.uri))
  await waitFor(async () => (await previewText()).includes("阅读原始文档。") && !(await previewText()).includes(previewLoadingMarker), "initial preview-only translation")
  assert(!owner.browse.has(uri), "Preview-only probe unexpectedly enabled browse.")
  const before = (await records()).length
  assert(await editor.edit((builder) => builder.replace(document.lineAt(0).range, "Read the complete field.")), "Preview source edit failed.")
  assert(await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "\n\n")), "Consecutive source shift failed.")
  await waitFor(async () => (await previewText()).includes("阅读完整字段。") && !(await previewText()).includes(previewLoadingMarker), "preview-only edit completion")
  assert((await records()).slice(before).reduce((sum, record) => sum + record.count, 0) === 1, "Preview-only edit resubmitted unchanged units.")
  assert((await previewText()).includes("保留其上下文。"), "Preview discarded its unchanged neighbour.")
  checks.push("preview-only consecutive edits reuse completed neighbours and follow shifted UTF-16 ranges")

  await owner.browse.start(document)
  await waitFor(() => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready", "browse joins preview cache")
  const typing = (await records()).length
  for (const text of ["Read", "Read the original", "Read the original document. Read the complete field."]) {
    assert(await editor.edit((builder) => builder.replace(document.lineAt(2).range, text)), "Typing edit failed.")
    owner.browse.refreshVisible()
    await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, new vscode.Position(2, 1))
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert((await records()).length === typing, "Continuous typing or hover sent an intermediate translation request.")
    assert(owner.browse.inspect(uri)?.units.length === 0, "Typing retained stale translations.")
  }
  await waitFor(
    async () => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready" && (await previewText()).includes("阅读原始文档。 阅读完整字段。"),
    "translation after typing settles"
  )
  assert((await records()).slice(typing).reduce((sum, record) => sum + record.count, 0) === 1, "Settled typing duplicated requests or resubmitted unchanged neighbours.")
  checks.push("continuous typing, viewport refresh and hover stay offline until idle, then browse and preview translate only the final changed unit")
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const originalDelay = config.inspect<number>("editDebounceMs")?.globalValue
  try {
    await config.update("editDebounceMs", 2000, vscode.ConfigurationTarget.Global)
    const delayed = (await records()).length
    assert(await editor.edit((builder) => builder.replace(document.lineAt(2).range, "Keep both lines together. Read the complete field.")), "Custom debounce edit failed.")
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assert((await records()).length === delayed, "Custom debounce sent a request at the default delay.")
    await waitFor(() => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready", "custom debounce completion")
    assert((await records()).slice(delayed).reduce((sum, record) => sum + record.count, 0) === 1, "Custom debounce duplicated translation requests.")
    await config.update("editDebounceMs", 0, vscode.ConfigurationTarget.Global)
    const immediate = (await records()).length
    assert(await editor.edit((builder) => builder.replace(document.lineAt(2).range, "Read the complete field. Keep both lines together.")), "Zero debounce edit failed.")
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert((await records()).length > immediate, "Zero debounce retained the previous or default wait.")
    await waitFor(() => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready", "zero debounce completion")
    checks.push("native debounce configuration delays edited requests for the chosen interval and supports zero without restarting browse")
  } finally {
    await config.update("editDebounceMs", originalDelay, vscode.ConfigurationTarget.Global)
  }
  const shared = (await records()).length
  assert(await editor.edit((builder) => builder.replace(document.lineAt(2).range, "Keep both lines together.")), "Shared preview/browse source edit failed.")
  await waitFor(
    async () => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready" && (await previewText()).includes("保留两行在一起。"),
    "shared edit completion"
  )
  assert((await records()).slice(shared).reduce((sum, record) => sum + record.count, 0) === 1, "Browse and preview duplicated or expanded edited-unit work.")
  assert(document.getText() === "\n\nKeep both lines together.\n\nKeep its context.", "Translation wrote to the edited source.")
  checks.push("browse and preview share only the changed unit after editing without writing source")

  const forced = (await records()).length
  assert(await editor.edit((builder) => builder.replace(document.lineAt(2).range, "Read the original document.")), "Pre-retranslation edit failed.")
  await owner.retranslate(document)
  await waitFor(
    async () => owner.browse.inspect(uri)?.units.length === 2 && owner.browse.inspect(uri)?.status === "ready" && (await previewText()).includes("阅读原始文档。"),
    "forced retranslation during edit debounce"
  )
  assert((await records()).slice(forced).reduce((sum, record) => sum + record.count, 0) === 2, "Edit reuse bypassed explicit whole-document retranslation.")
  owner.browse.stop(uri, false)
  owner.preview.close(preview.uri)
  checks.push("whole-document retranslation during edit debounce still refreshes all units")
  return checks
}
