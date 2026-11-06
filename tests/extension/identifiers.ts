import assert from "node:assert/strict"
import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"

export async function runIdentifiers(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const keys = ["hover.enabled", "hover.identifiers", "hover.documentation", "hover.comments", "hover.strings", "includeContext", "maxContextCharacters", "auto.enabled"]
  const previous = keys.map((key) => config.inspect(key)?.globalValue)
  const originalEditor = vscode.window.activeTextEditor
  const uri = vscode.Uri.joinPath(workspace, "identifier-hover.ts")
  const source = 'const getUserProfile = (userId: string) => userId\ngetUserProfile("sample")\n// getUserProfile\nconst text = "getUserProfile"\n'
  const requests = async () =>
    ((await (await fetch(origin + "/state")).json()) as { requests: { inputFingerprint?: string; referenceIncluded?: boolean; contextCharacters?: number }[] }).requests
  const control = async (value: object) => {
    assert.ok((await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) })).ok)
  }

  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10000
    while (!(await check())) {
      assert.ok(Date.now() < deadline, "Identifier hover did not reach the expected HTTP state.")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const values = (hovers: readonly vscode.Hover[]) => hovers.flatMap((hover) => hover.contents.map((item) => (typeof item === "string" ? item : item.value))).join("\n")
  let documentation: vscode.Disposable | undefined
  try {
    for (const [language, source, name] of [
      ["python", "def get_user_profile(ctx):\r\n    return ctx\r\n", "get_user_profile"],
      ["rust", "fn get_user_profile() {}", "get_user_profile"],
      ["typescript", "class HTTPResponse {}", "HTTPResponse"]
    ]) {
      const document = await vscode.workspace.openTextDocument({ language, content: source })
      assert.equal((await owner.documents.identifier(document, source.indexOf(name)))?.text, name, "Real grammar did not expose the expected name: " + language)
      assert.equal(await owner.documents.identifier(document, 0), undefined, "Real grammar exposed a keyword as a name: " + language)
    }
    for (const [key, value] of Object.entries({
      "hover.enabled": true,
      "hover.documentation": false,
      "hover.comments": false,
      "hover.strings": false,
      includeContext: true,
      maxContextCharacters: 2000,
      "auto.enabled": false
    }))
      await config.update(key, value, vscode.ConfigurationTarget.Global)
    await config.update("hover.identifiers", undefined, vscode.ConfigurationTarget.Global)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    assert.equal((await owner.documents.identifier(document, 10))?.text, "getUserProfile", "Real TypeScript grammar did not recognize the name.")
    const hover = async (line = 0, character = 10) => vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(line, character))
    const before = (await requests()).length
    await hover()
    assert.equal((await requests()).length, before, "Default hover submitted a code name for translation.")
    await config.update("hover.identifiers", true, vscode.ConfigurationTarget.Global)
    assert.ok(values(await hover()).includes("获取用户资料"), "Name without documentation did not translate.")
    documentation = vscode.languages.registerHoverProvider(
      { pattern: "**/identifier-hover.ts" },
      {
        provideHover: (_document, position) => (position.line < 2 ? new vscode.Hover(new vscode.MarkdownString("Read the original document.")) : undefined)
      }
    )
    const translated = values(await hover())
    assert.ok(translated.includes("获取用户资料") && translated.includes("Read the original document."), "Name translation lost its meaning or native documentation.")
    assert.ok(!translated.includes("command:commentTranslatePlus.replaceHover"), "Name translation exposed source replacement.")
    const sent = (await requests()).slice(before)
    assert.equal(sent.length, 2)
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("get User Profile"))
    assert.equal(sent[0].inputFingerprint, [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join(""))
    assert.ok(sent[0].referenceIncluded && sent[0].contextCharacters! <= 2000, "Name request lost its bounded source/documentation references.")
    await hover(0, 14)
    assert.equal((await requests()).length, before + 2, "Moving within a name repeated its translation request.")
    for (const position of [
      [0, 1],
      [0, 21],
      [2, 6],
      [3, 17]
    ])
      await hover(position[0], position[1])
    assert.equal((await requests()).length, before + 2, "Keyword, punctuation, comment or string became a code-name request.")
    await config.update("hover.documentation", true, vscode.ConfigurationTarget.Global)
    const combined = values(await hover())
    assert.ok(
      combined.includes("获取用户资料") && combined.includes("阅读原始文档。") && combined.includes("Read the original document."),
      "Name and documentation translations did not coexist."
    )
    await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
    assert.equal(document.getText(), source)
    assert.equal(document.isDirty, false)
    assert.equal((await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)).length, 0)

    // A new source name must receive a new translation while concurrent hovers share it.
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 6, 0, 20), "getUserRecord"))
    await control({ hold: true })
    const beforePending = (await requests()).length
    const first = hover(0, 9)
    await waitFor(async () => (await requests()).length > beforePending)
    const second = hover(0, 13)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await requests()).length, beforePending + 1, "Concurrent name hovers did not share in-flight HTTP.")
    await control({ hold: false })
    assert.ok(values(await first).includes("获取用户记录") && values(await second).includes("获取用户记录"))
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 6, 0, 19), "HTTPResponse"))
    await control({ hold: true })
    const beforeCancelled = (await requests()).length
    const stale = hover(0, 9)
    await waitFor(async () => (await requests()).length > beforeCancelled)
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 6, 0, 18), "getUserProfile"))
    await control({ hold: false })
    assert.ok(!values(await stale).includes("HTTP 响应"), "Editing a name displayed its obsolete translation.")
    assert.ok(values(await hover(0, 9)).includes("获取用户资料"), "Edited name did not resume with its own meaning.")
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 6, 0, 20), "HTTPResponse"))
    await control({ hold: true })
    const beforeDisabled = (await requests()).length
    const disabled = hover(0, 9)
    await waitFor(async () => (await requests()).length > beforeDisabled)
    await config.update("hover.identifiers", false, vscode.ConfigurationTarget.Global)
    await control({ hold: false })
    assert.ok(!values(await disabled).includes("HTTP 响应"), "Disabling name hover displayed an obsolete response.")
    const afterDisabled = (await requests()).length
    await hover(0, 9)
    assert.equal((await requests()).length, afterDisabled, "Disabled name hover still submitted translation.")
    console.log("Identifier hover: real grammar, HTTP, native docs, cache, in-flight sharing and configuration cancellation passed.")
    return ["identifier hover defaults off, recognizes real code scopes, preserves native docs and source, shares cache/in-flight work and rejects disabled late results"]
  } finally {
    await control({ hold: false })
    documentation?.dispose()
    for (let index = 0; index < keys.length; index++) await config.update(keys[index], previous[index], vscode.ConfigurationTarget.Global)
    const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    if (document && !document.isClosed) {
      await vscode.window.showTextDocument(document, { preview: false })
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    if (originalEditor && !originalEditor.document.isClosed) await vscode.window.showTextDocument(originalEditor.document, { viewColumn: originalEditor.viewColumn, preview: false })
  }
}
