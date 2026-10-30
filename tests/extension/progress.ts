import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    assert(Date.now() < deadline, "Global translation progress did not reach the expected state.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runProgress(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const initial = vscode.window.activeTextEditor
  const shared = "Read the original document. GlobalProgressShared."
  const source = [shared, shared, "Read the original document. GlobalProgressOther."]
  const documents: vscode.TextDocument[] = []
  for (const [index, text] of source.entries()) {
    const uri = vscode.Uri.joinPath(workspace, "progress-" + index + ".md")
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
    documents.push(await vscode.workspace.openTextDocument(uri))
  }
  const observed: number[] = []
  const events = owner.translations.onDidChangeProgress(() => observed.push(owner.translations.progress().pending))
  const control = async (hold: boolean) => {
    assert((await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold }) })).ok, "Progress mock control failed.")
  }
  const controllers = source.map(() => new AbortController())
  const tasks: Promise<unknown>[] = []
  try {
    await control(true)
    for (const [index, document] of documents.entries()) {
      const parsed = await owner.documents.parse(document)
      tasks.push(owner.translations.translate(document, { units: parsed.groups.flatMap((group) => group.units) }, controllers[index].signal))
    }
    const firstCancelled = tasks[0].catch(() => undefined)
    const otherCancelled = tasks[2].catch(() => undefined)
    await waitFor(() => owner.translations.progress().pending === 2 && observed.includes(2))
    assert(
      documents.every((document) => owner.translations.progress(document.uri).current === 1),
      "Pending work was not attributed to each consuming source file."
    )
    await vscode.window.showTextDocument(documents[1], { preview: false })
    assert(owner.translations.progress().pending === 2, "Switching tabs changed the global pending count.")
    const outside = await vscode.workspace.openTextDocument({ language: "plaintext", content: "Unrelated text tab." })
    await vscode.window.showTextDocument(outside)
    assert(
      owner.translations.progress().pending === 2 && owner.translations.progress(outside.uri).current === 0,
      "An unrelated editor changed global work or inherited another file's progress."
    )
    controllers[0].abort("user-cancelled")
    await firstCancelled
    assert(
      owner.translations.progress(documents[0].uri).current === 0 && owner.translations.progress(documents[1].uri).current === 1,
      "Cancelling one file changed the remaining owner's progress."
    )
    assert(owner.translations.progress().pending === 2, "A shared unit was counted twice or lost its remaining consumer.")
    controllers[2].abort("user-cancelled")
    await otherCancelled
    await waitFor(() => owner.translations.progress().pending === 1 && observed.includes(1))
    await control(false)
    await tasks[1]
    await waitFor(() => owner.translations.progress().pending === 0 && observed.at(-1) === 0)
  } finally {
    for (const controller of controllers) controller.abort("user-cancelled")
    await control(false)
    await Promise.allSettled(tasks)
    events.dispose()
    if (initial) await vscode.window.showTextDocument(initial.document, { preview: false })
  }
  return ["global progress deduplicates shared work across tabs and follows completion and cancellation even while a non-source editor is active"]
}
