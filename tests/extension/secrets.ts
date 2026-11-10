import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { validatedText } from "../support/assertions.ts"

export async function runSecrets(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  const seen: { role: string; content: string }[][] = []
  const apiKey = "mock-privacy-auth"
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    assert.equal(request.headers.authorization, "Bearer " + apiKey)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[] }
    seen.push(body.messages)
    response.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: body.messages.find((message) => message.role === "user")!.content.replace("Read the original document.", "阅读原始文档。") } }
        ]
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const settings = {
    "service.profiles": [
      {
        id: "privacy",
        provider: "openai",
        apiUrl: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
        model: "fixture",
        apiKey,
        systemPrompt: "${context}\nService credential: " + apiKey,
        userPrompt: "${content}"
      }
    ],
    "service.activeProfile": "privacy",
    "request.includeContext": true,
    "language.skipSameLanguage": false,
    "auto.enabled": false
  }
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, config.inspect(key)?.globalValue]))
  const uri = vscode.Uri.joinPath(workspace, "privacy-fixture.md")
  const short = apiKey
  const long = "sk-" + "Aa12".repeat(5) + "T3BlbkFJ" + "Bc23".repeat(5)
  const source = 'Read the original document. Password="' + short + '"; credential `' + long + "`."
  const editor = vscode.window.activeTextEditor
  try {
    for (const [key, value] of Object.entries(settings)) await config.update(key, value, vscode.ConfigurationTarget.Global)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document)
    await owner.browse.start(document)
    const deadline = Date.now() + 10000
    while (owner.browse.inspect(uri)?.status !== "ready") {
      assert.ok(Date.now() < deadline && owner.browse.inspect(uri)?.status !== "error", "Privacy-protected reading did not complete.")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const translated = validatedText(owner.browse.inspect(uri)!.units[0].translation)
    assert.equal(translated, source.replace("Read the original document.", "阅读原始文档。"))
    assert.ok(seen.length > 0)
    for (const value of [short, long, apiKey]) assert.ok(!JSON.stringify(seen).includes(value), "A credential reached the simulated model.")
    const calls = seen.length
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(0, 5))
    assert.ok(
      hovers
        .flatMap((hover) => hover.contents.map((content) => (typeof content === "string" ? content : content.value)))
        .join("\n")
        .includes(short)
    )
    assert.equal(seen.length, calls, "Hover failed to reuse the restored result.")
    assert.equal(document.getText(), source)
    assert.equal(document.isDirty, false)
    console.log("Sensitive content: authenticated HTTP hides credentials; reading and hover restore locally without changing source.")
    return [
      "native settings protect body, Original references and template credentials before authenticated HTTP",
      "reading and hover share locally restored credentials without changing source"
    ]
  } finally {
    owner.browse.stop(uri, true)
    for (const [key, value] of Object.entries(previous)) await config.update(key, value, vscode.ConfigurationTarget.Global)
    if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
