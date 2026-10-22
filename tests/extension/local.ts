import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"

interface LocalTestConfiguration {
  readonly origin: string
  readonly mode: string
  readonly bundleHash: string
  readonly ui?: boolean
  readonly serviceSettings: { readonly profiles: { id: string; provider: string; apiUrl: string; model: string; apiKey?: string }[]; readonly targetLanguage: string } & Record<
    string,
    unknown
  >
}

const sample = "1. Read the original document.\n2. Keep `sourceId` unchanged."

async function fingerprint(uri: vscode.Uri): Promise<string> {
  const bytes = await (await fetch(vscode.Uri.joinPath(uri, "dist/extension.cjs").toString())).arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

async function configuration(): Promise<{ workspace: vscode.Uri; test: LocalTestConfiguration }> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!workspace) throw Error("Missing local test workspace.")
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, "web-test.json"))
  return { workspace, test: JSON.parse(new TextDecoder().decode(bytes)) as LocalTestConfiguration }
}

async function inject(): Promise<void> {
  const { workspace, test } = await configuration()
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  for (const [key, value] of Object.entries(test.serviceSettings)) await config.update(key, value, vscode.ConfigurationTarget.Global)
  const uri = vscode.Uri.joinPath(workspace, "local-browse.md")
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(sample + (test.ui ? " ![](./preview.svg)" : "")))
  if (test.ui) {
    await vscode.workspace.getConfiguration("editor").update("wordWrap", "on", vscode.ConfigurationTarget.Global)
    await vscode.workspace.getConfiguration("editor").update("scrollBeyondLastLine", true, vscode.ConfigurationTarget.Global)
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workspace, "preview.svg"),
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#409060"/></svg>')
    )
    const wrapped =
      "```ts\n" +
      "const untouched = 1;\n".repeat(60) +
      "```\n\nRead the original document. " +
      "Wrap the complete original paragraph without moving its last row. ".repeat(10) +
      "EndOfWrappedSource."
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, "below-wrapped.md"), new TextEncoder().encode(wrapped))
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workspace, "unchanged-browse.md"),
      new TextEncoder().encode("AcmeSDK keeps its original product name.\n\nRead the original document.")
    )
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workspace, "hover replacement (中文 %25).md"),
      new TextEncoder().encode("You are a professional ${targetLang} translator. Translate each source item accurately and fluently. HoverReplaceProbe %20 %2520 %3A %E4%B8%AD")
    )
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, "hover-pending.md"), new TextEncoder().encode("Read the original document. HoverPendingProbe"))
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workspace, "protected-content.md"),
      new TextEncoder().encode("`members` is required when `supersedes` is set. ProtectedContentProbe\n\n**B — Industry / Competitive.** Confirm scope across **Comparison dimensions**.")
    )
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workspace, "preview-loading.md"),
      new TextEncoder().encode(
        '---\nlabel: "Read the original document."\n---\n\n# Preview loading sample ##\n\nSetext title\n---\n\n1. Read the original document.\n2. Keep `sourceId` unchanged.\n\n| Field | Description |\n| --- | --- |\n| name | Read the original document. |\n\n```ts\nconst untouched = 1;\n```'
      )
    )
  }
  const document = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  const response = await fetch(test.origin + "/credentials")
  if (!response.ok) throw Error("Local credential injection failed.")
  const { apiKey } = (await response.json()) as { apiKey: string }
  await config.update(
    "profiles",
    test.serviceSettings.profiles.map((profile) => ({ ...profile, apiKey })),
    vscode.ConfigurationTarget.Global
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  if (test.ui) {
    const extension = vscode.extensions.getExtension("cattle-horse.vscode-comment-translate-plus")
    if (!extension) throw Error("UI setup could not find the product extension.")
    const metadata = { vscode: vscode.version, bundleHash: await fingerprint(extension.extensionUri), uiKind: vscode.env.uiKind }
    const response = await fetch(test.origin + "/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) })
    if (!response.ok) throw Error("UI setup could not report the loaded build.")
  }
}

// Used only by the isolated test host's temporary setup extension, never by the product bundle.
export async function activate(): Promise<void> {
  try {
    await inject()
  } catch {
    void vscode.window.showErrorMessage("本地测试配置注入失败，请查看测试终端。")
    throw Error("Local test setup failed.")
  }
}

export async function run(): Promise<void> {
  if (vscode.env.uiKind !== vscode.UIKind.Web) throw Error("Local tests require the official VS Code Web host.")
  const { workspace, test } = await configuration()
  const started = performance.now()
  const extension = vscode.extensions.getExtension<Application>("cattle-horse.vscode-comment-translate-plus")
  if (!extension) throw Error("Product extension was not discovered.")
  const uri = vscode.Uri.joinPath(workspace, "local-browse.md")
  const deadline = Date.now() + 90000
  try {
    while (true) {
      const snapshot = extension.isActive ? extension.exports.browse.inspect(uri) : undefined
      if (snapshot?.status === "error") throw Error(`Local translation rejected: ${snapshot.errors.join(", ")}`)
      if (snapshot?.status === "ready" && snapshot.units.length === 2) break
      if (Date.now() >= deadline) throw Error("Local translation timed out.")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const controller = extension.exports
    const document = await vscode.workspace.openTextDocument(uri)
    const snapshot = controller.browse.inspect(uri)!
    if (document.getText() !== sample || document.isDirty) throw Error("Local browse changed the source.")
    if (!snapshot.units.every((unit) => /\p{Script=Han}/u.test(unit.translation) && unit.translation !== unit.text)) throw Error("Local service did not produce Chinese translations.")
    const config = vscode.workspace.getConfiguration("commentTranslatePlus")
    const profile = config.get<{ model: string; apiUrl: string }[]>("profiles", [])[0]
    if (profile?.model !== test.serviceSettings.profiles[0].model || profile.apiUrl !== test.serviceSettings.profiles[0].apiUrl)
      throw Error("Injected service configuration differs from the requested profile.")
    const bundleHash = await fingerprint(extension.extensionUri)
    if (bundleHash !== test.bundleHash) throw Error("Local test loaded the wrong product bundle.")
    const report = {
      host: "vscode-test-web",
      mode: test.mode,
      vscode: vscode.version,
      bundleHash,
      checks: [
        "startup setup extension injects service profile and discovered model automatically",
        "test credential configured through the native settings API without a dialog",
        "real local HTTP service returns two ID-matched Chinese translations",
        "source document remains unchanged and clean",
        "loaded product bundle fingerprint matches"
      ],
      service: { apiUrl: profile.apiUrl, model: profile.model },
      elapsedMs: performance.now() - started,
      units: snapshot.units.map((unit) => ({ start: unit.start, end: unit.end, translation: unit.translation })),
      liveTranslationVerified: true,
      visualLayoutVerified: false
    }
    const response = await fetch(test.origin + "/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) })
    if (!response.ok) throw Error("Could not save local test report.")
    console.log(`Local service test passed: ${profile.model}, ${snapshot.units.length} translated items.`)
  } catch (error) {
    const diagnostic = error instanceof Error ? (error.message.match(/^Local translation rejected: ([a-z0-9,-]+)$/)?.[1] ?? "local-test-failed") : "local-test-failed"
    await fetch(test.origin + "/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "failed", diagnostic }) })
    throw error
  } finally {
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await vscode.workspace.getConfiguration("commentTranslatePlus").update("profiles", [], vscode.ConfigurationTarget.Global)
  }
}
