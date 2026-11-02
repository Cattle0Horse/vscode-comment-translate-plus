import * as vscode from "vscode"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { parseMarkdown } from "../../src/documents/markdown.ts"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

export async function runFileLogging(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const settings = {
    profiles: [{ id: "file-log", name: "File logging", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "local-test", apiKey: "mock-test" }],
    activeProfile: "file-log",
    logLevel: "error",
    logDetails: false,
    logFile: "diagnostics/agent.jsonl"
  }
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, config.inspect(key)?.globalValue]))

  async function update(key: string, value: unknown): Promise<void> {
    const effective = value === undefined ? config.inspect(key)?.defaultValue : value
    if (JSON.stringify(config.get(key)) === JSON.stringify(effective)) {
      await config.update(key, value, vscode.ConfigurationTarget.Global)
      return
    }
    let subscription: vscode.Disposable
    const changed = new Promise<void>((resolve) => {
      subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("commentTranslatePlus." + key)) resolve()
      })
    })
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global)
      await changed
    } finally {
      subscription!.dispose()
    }
  }

  const first = vscode.Uri.joinPath(workspace, settings.logFile)
  const second = vscode.Uri.joinPath(workspace, "diagnostics/second.md")

  async function untilRecord(path: string, kind: string): Promise<Record<string, any>[]> {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        const records = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        if (records.some((record) => record.kind === kind)) return records
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw Error("File log did not receive " + kind)
  }

  try {
    await mkdir(dirname(first.fsPath), { recursive: true })
    await writeFile(first.fsPath, '{"kind":"existing-evidence"}\n')
    for (const [key, value] of Object.entries(settings)) await update(key, value)
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: "Read the original document. Keep mock-test private." })
    const input = { units: parseMarkdown(document.getText()).groups.flatMap((group) => group.units) }
    await owner.translations.translate(document, input, new AbortController().signal, true)
    const records = await untilRecord(first.fsPath, "finish")
    const request = records.find((record) => record.kind === "request")!
    const start = records.find((record) => record.kind === "start")!
    assert(records[0].kind === "existing-evidence", "File logging overwrote existing evidence.")
    assert(start.units.length === input.units.length && start.units[0].start === input.units[0].start, "Agent log lost original unit boundaries.")
    assert(
      request.modelRequest.messages.some((message: { role: string }) => message.role === "system"),
      "Agent log omitted full system messages with human details disabled."
    )
    assert(
      typeof request.modelResponse === "string" && request.file === document.uri.toString() && request.documentVersion === document.version,
      "Agent log lost response or source identity."
    )
    assert(!(await readFile(first.fsPath, "utf8")).includes("mock-test"), "Agent log leaked the profile credential.")
    await update("logFile", second.fsPath)
    await owner.translations.translate(document, input, new AbortController().signal, true)
    const switched = await untilRecord(second.fsPath, "finish")
    assert(
      switched.some((record) => record.kind === "request" && record.modelRequest.messages.some((message: { role: string }) => message.role === "system")),
      "New file depends on system references in the old file."
    )
    const logDocument = await vscode.workspace.openTextDocument(second)
    assert(!owner.documents.supports(logDocument) && (await owner.documents.parse(logDocument)).groups.length === 0, "Agent log became translatable source.")
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", second, new vscode.Position(0, 1))
    assert(!hovers.length, "Agent log created a translation hover.")
    const fileUri = vscode.Uri.joinPath(workspace, "diagnostics/URI 日志 #1%.jsonl")
    await update("logFile", fileUri.toString())
    owner.translations.diagnose(Error("service-timeout"))
    const fileUriRecords = await untilRecord(fileUri.fsPath, "diagnostic")
    assert(fileUriRecords.some((record) => record.code === "service-timeout") && owner.translations.isLogFile(fileUri), "File URI logging resolved to a different destination.")
    const saved = await readFile(fileUri.fsPath, "utf8")
    await update("logFile", "")
    owner.translations.diagnose(Error("service-timeout"))
    assert((await readFile(fileUri.fsPath, "utf8")) === saved, "Disabling file logging appended new evidence.")
    return [
      "native logFile settings append complete redacted JSONL events independently of human log level/details",
      "switching relative/absolute destinations preserves standalone model evidence and excludes the log from parsing and hover",
      "native file URI log settings resolve to the same local file and preserve output exclusion",
      "disabling logFile stops future file output"
    ]
  } finally {
    await update("logFile", previous.logFile)
    for (const [key, value] of Object.entries(previous)) if (key !== "logFile") await update(key, value)
  }
}
