import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { runHostCases } from "./cases.ts"
import type { HostCaseResult } from "./cases.ts"
import { runFeatures } from "./features.ts"
import { runEditReuse } from "./edits.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function run(): Promise<void> {
  assert(vscode.env.uiKind === vscode.UIKind.Web, "Tests must run in official VS Code Web.")
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
  assert(workspace, "Missing virtual test workspace.")
  const configBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, "web-test.json"))
  const test = JSON.parse(new TextDecoder().decode(configBytes)) as { origin: string; mode: string; bundleHash: string }
  const checks: string[] = []
  let cases: HostCaseResult[] = []

  async function control(value: object): Promise<void> {
    const response = await fetch(test.origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) })
    assert(response.ok, "Local mock control failed.")
  }

  async function requests(): Promise<{ target: string; count: number; retryFeedbackIncluded: boolean; cancelled: boolean }[]> {
    return ((await (await fetch(test.origin + "/state")).json()) as { requests: { target: string; count: number; retryFeedbackIncluded: boolean; cancelled: boolean }[] }).requests
  }

  const source = "1. Read the original document.\n2. Keep `sourceId` and [guide](https://example.com)."
  const uri = vscode.Uri.joinPath(workspace, "browse-probe.md")
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
  const document = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  const extension = vscode.extensions.getExtension<Application>("cattle-horse.vscode-comment-translate-plus")
  assert(extension, "Extension not found.")
  await waitFor(() => extension.isActive, "Markdown activation")
  const controller = extension.exports
  assert(!controller.browse.inspect(uri), "Opening the document must not start translation.")
  checks.push("official Web Worker host activates without automatic service calls")
  const bytes = await (await fetch(vscode.Uri.joinPath(extension.extensionUri, "dist/extension.cjs").toString())).arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const bundleHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
  assert(bundleHash === test.bundleHash, "Loaded bundle differs from the selected build or VSIX.")
  checks.push("loaded bundle matches the selected build or extracted production VSIX")

  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const settings = {
    profiles: [{ id: "test", name: "HTTP test", provider: "openai", apiUrl: test.origin + "/v1/chat/completions", model: "local-test", apiKey: "mock-test" }],
    activeProfile: "test",
    targetLanguage: "zh-CN",
    maxRequestsPerSecond: 100,
    maxConcurrentRequests: 2,
    maxItemsPerRequest: 20
  }
  try {
    for (const [key, value] of Object.entries(settings)) await config.update(key, value, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "initial HTTP translation")
    assert(document.getText() === source && !document.isDirty, "Browse changed source.")
    assert(controller.browse.inspect(uri)!.units[0].translation.includes("阅读原始文档"), "Wrong ID mapping.")
    checks.push("plain-text browser HTTP responses map ordered units without changing the source")
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri, 1000)
    const translatedLenses = lenses.filter((lens) => lens.command?.title === " ")
    assert(
      translatedLenses.length === 1 && translatedLenses[0].range.start.line === 1,
      "Translation spacing must follow the source; the final line must not create an out-of-range CodeLens."
    )
    const beforeHover = (await requests()).length
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(0, 5))
    assert(
      hovers.some((hover) => hover.contents.some((content) => typeof content !== "string" && content.value.includes("阅读原始文档"))),
      "Source hover did not expose its full translation."
    )
    assert(beforeHover === (await requests()).length, "Browse hover unexpectedly issued another request.")
    checks.push("native CodeLens rows and source hover expose the matching translations")
    await vscode.commands.executeCommand("commentTranslatePlus.showErrors")
    await vscode.commands.executeCommand("workbench.action.closePanel")
    checks.push("profile credentials from native settings authenticate HTTP requests")

    const beforeToggle = (await requests()).length
    for (let cycle = 0; cycle < 3; cycle++) {
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      assert(!controller.browse.inspect(uri), "Stopped browse remained visible.")
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "cached browse restart")
    }
    assert((await requests()).length === beforeToggle, "Browse toggles discarded validated cache and repeated HTTP requests.")
    checks.push("repeated stop and start restore validated translations without HTTP requests")

    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    assert(await editor.edit((builder) => builder.replace(document.lineAt(0).range, "1. Edited while browse is off.")), "Disabled edit failed.")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(!controller.browse.inspect(uri) && (await requests()).length === beforeToggle, "Disabled edits restarted translation.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "changed disabled content")
    assert(
      (await requests()).length === beforeToggle + 1 && controller.browse.inspect(uri)!.units[0].text.includes("Edited while browse is off"),
      "Disabled edits reused stale translations."
    )
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup")
    await vscode.commands.executeCommand("undo")
    await waitFor(() => document.getText() === source && controller.browse.inspect(uri)?.units.length === 2, "undo disabled edit")
    assert((await requests()).length === beforeToggle + 1 && !document.isDirty, "Undo did not reuse the original validated cache.")
    checks.push("disabled edits stay offline and changed content cannot reuse stale translations")

    const beforeEdit = (await requests()).length
    assert(await editor.edit((builder) => builder.replace(document.lineAt(0).range, "1. Read the complete field.")), "Edit failed.")
    assert(controller.browse.inspect(uri)!.units.length === 0, "Edit did not invalidate display.")
    const editedHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(0, 5))
    assert(
      !editedHovers.some((hover) => hover.contents.some((content) => typeof content !== "string" && content.value.includes("阅读原始文档"))),
      "Edit left the old translation in hover."
    )
    const editedLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)
    assert(!editedLenses.some((lens) => lens.command?.title.includes("阅读原始文档")), "Edit left the old translation in CodeLens.")
    await waitFor(() => controller.browse.inspect(uri)?.units.length === 2, "edited translation")
    assert((await requests()).slice(beforeEdit).reduce((sum, request) => sum + request.count, 0) === 1, "Editing one list item resubmitted its unchanged neighbour.")
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup")
    await vscode.commands.executeCommand("undo")
    await waitFor(() => document.getText() === source && controller.browse.inspect(uri)?.units.length === 2, "native undo")
    assert(!document.isDirty, "Translation polluted undo history.")
    checks.push("browser editor invalidates edits and preserves native undo")

    const before = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(async () => (await requests()).length > before && controller.browse.inspect(uri)?.status === "ready", "forced retranslation")
    checks.push("forced retranslation bypasses cache")

    await control({ broken: true })
    const beforeFailure = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(() => controller.browse.inspect(uri)?.status === "error", "invalid response rejection")
    assert(controller.browse.inspect(uri)!.units.length === 0, "Invalid result was displayed.")
    const failedRequests = (await requests()).slice(beforeFailure)
    assert(
      failedRequests.length > 1 && !failedRequests[0].retryFeedbackIncluded && failedRequests.slice(1).every((request) => request.retryFeedbackIncluded),
      "Automatic retries omitted validation feedback."
    )
    checks.push("automatic retries send validation feedback only after a failed attempt")
    await control({ broken: false })
    await vscode.commands.executeCommand("commentTranslatePlus.retry")
    await waitFor(() => controller.browse.inspect(uri)?.units.length === 2, "retry recovery")
    checks.push("invalid batches remain untranslated and retry recovers")

    await control({ damageCode: true })
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(() => controller.browse.inspect(uri)?.status === "error" && controller.browse.inspect(uri)?.units.length === 1, "partial validated results")
    assert(controller.browse.inspect(uri)!.units[0].translation.includes("阅读原始文档") && document.getText() === source, "A damaged unit hid verified neighbours or changed source.")
    await control({ damageCode: false })
    const beforePartialRetry = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.retry")
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "partial retry recovery")
    const repairs = (await requests()).slice(beforePartialRetry)
    assert(repairs.length === 1 && repairs[0].count === 1, "Retry retranslated a verified neighbour.")
    checks.push("partial failures preserve visible verified units and retry only unresolved content")

    await config.update("targetLanguage", "ja", vscode.ConfigurationTarget.Global)
    await waitFor(async () => (await requests()).at(-1)?.target === "ja" && controller.browse.inspect(uri)?.status === "ready", "language restart")
    checks.push("language changes isolate old translation context")

    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const beforeDisabledConfiguration = (await requests()).length
    await config.update("targetLanguage", "fr", vscode.ConfigurationTarget.Global)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(!controller.browse.inspect(uri) && (await requests()).length === beforeDisabledConfiguration, "Configuration changes reopened disabled browse.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(
      async () => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2 && (await requests()).at(-1)?.target === "fr",
      "disabled configuration isolation"
    )
    assert((await requests()).length === beforeDisabledConfiguration + 1, "Old language cache crossed a disabled configuration change.")
    checks.push("disabled configuration changes invalidate cache without restarting browse")

    const beforeItemLimit = (await requests()).length
    const itemLimitChanged = new Promise<void>((resolve) => {
      const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("commentTranslatePlus.maxItemsPerRequest")) return
        subscription.dispose()
        resolve()
      })
    })
    await config.update("maxItemsPerRequest", 1, vscode.ConfigurationTarget.Global)
    await itemLimitChanged
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "item limit cache restore")
    assert((await requests()).length === beforeItemLimit, "Changing HTTP grouping discarded unit cache.")
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(
      async () => controller.browse.inspect(uri)?.status === "ready" && (await requests()).length === beforeItemLimit + 2 && (await requests()).slice(-2).every((item) => item.count === 1),
      "new request item limit"
    )
    checks.push("request item limit changes actual HTTP grouping on forced translation while regrouping preserves unit cache")

    await config.update("maxRequestsPerSecond", 1, vscode.ConfigurationTarget.Global)
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "rate setting restart")
    const limitedBefore = (await requests()).length
    const limitedStart = performance.now()
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(async () => (await requests()).length >= limitedBefore + 2 && controller.browse.inspect(uri)?.status === "ready", "rate-limited requests")
    assert(performance.now() - limitedStart >= 1000, "Rate setting did not throttle actual requests.")
    await config.update("maxRequestsPerSecond", 100, vscode.ConfigurationTarget.Global)
    await waitFor(() => controller.browse.inspect(uri)?.status === "ready" && controller.browse.inspect(uri)?.units.length === 2, "restored test rate")
    checks.push("rate setting throttles actual browser requests rather than only changing metadata")

    const otherUri = vscode.Uri.joinPath(workspace, "other.md")
    await vscode.workspace.fs.writeFile(otherUri, new TextEncoder().encode(source))
    const other = await vscode.workspace.openTextDocument(otherUri)
    await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Two, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === otherUri.toString(), "second document focus")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => controller.browse.inspect(otherUri)?.units.length === 2, "second document translation")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    assert(!controller.browse.inspect(otherUri) && controller.browse.inspect(uri), "Browse controls crossed documents.")
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), "first document focus")
    checks.push("multiple files have independent browse controls")

    const scrollUri = vscode.Uri.joinPath(workspace, "scroll-retention.md")
    const scrollSource = "Viewport first paragraph." + "\n".repeat(180) + "Viewport last paragraph."
    await vscode.workspace.fs.writeFile(scrollUri, new TextEncoder().encode(scrollSource))
    const scrollDocument = await vscode.workspace.openTextDocument(scrollUri)
    const scrollEditor = await vscode.window.showTextDocument(scrollDocument, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    const firstRange = new vscode.Range(0, 0, 0, 0)
    const lastRange = new vscode.Range(180, 0, 180, 0)
    scrollEditor.revealRange(firstRange, vscode.TextEditorRevealType.AtTop)
    await waitFor(() => scrollEditor.visibleRanges.some((range) => range.contains(firstRange)), "scroll probe starts at first paragraph")
    const beforeScroll = (await requests()).length
    await control({ hold: true })
    try {
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      await waitFor(async () => (await requests()).length === beforeScroll + 1, "first viewport request started")
      scrollEditor.revealRange(lastRange, vscode.TextEditorRevealType.AtTop)
      await waitFor(async () => (await requests()).length === beforeScroll + 2, "last viewport request started")
      assert(!scrollEditor.visibleRanges.some((range) => range.contains(firstRange)), "First paragraph did not leave the viewport.")
      assert(controller.browse.inspect(scrollUri)?.loading.length === 2, "Scrolling removed an in-flight loading unit.")
      scrollEditor.revealRange(firstRange, vscode.TextEditorRevealType.AtTop)
      await waitFor(() => scrollEditor.visibleRanges.some((range) => range.contains(firstRange)), "return to pending first paragraph")
    } finally {
      await control({ hold: false })
    }
    await waitFor(() => controller.browse.inspect(scrollUri)?.status === "ready" && controller.browse.inspect(scrollUri)?.units.length === 2, "offscreen translation completes")
    const scrollRequests = (await requests()).slice(beforeScroll)
    assert(scrollRequests.length === 2 && scrollRequests.every((request) => !request.cancelled), "Scrolling cancelled or repeated a submitted HTTP request.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => controller.browse.inspect(scrollUri)?.units.length === 1, "visible cached first paragraph")
    scrollEditor.revealRange(lastRange, vscode.TextEditorRevealType.AtTop)
    await waitFor(() => controller.browse.inspect(scrollUri)?.units.length === 2, "cached offscreen paragraph")
    assert((await requests()).length === beforeScroll + 2, "An offscreen result was not cached.")
    assert(scrollDocument.getText() === scrollSource && !scrollDocument.isDirty, "Scrolling translation changed source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    checks.push("viewport scrolling keeps submitted HTTP requests alive and caches offscreen results without duplicate requests")

    await control({ slow: true })
    const beforeCancel = (await requests()).length
    await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
    await waitFor(async () => (await requests()).length > beforeCancel, "delayed request started")
    assert((controller.browse.inspect(uri)?.loading.length ?? 0) > 0, "An in-flight request exposed no loading units.")
    await vscode.commands.executeCommand("commentTranslatePlus.cancel")
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert(
      controller.browse.inspect(uri)?.status === "cancelled" && controller.browse.inspect(uri)?.units.length === 0 && controller.browse.inspect(uri)?.loading.length === 0,
      "Late result or loading state survived cancellation."
    )
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    assert(!controller.browse.inspect(uri), "Stop did not release the file.")
    await config.update("hover.enabled", false, vscode.ConfigurationTarget.Global)
    const stoppedHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(0, 5))
    assert(!stoppedHovers.some((hover) => hover.contents.some((content) => typeof content !== "string" && content.value.includes("注释翻译+"))), "Hover survived stop.")
    const stoppedLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)
    assert(!stoppedLenses.length, "CodeLens survived stop.")
    checks.push("cancel and stop discard delayed responses")

    await control({ slow: false })
    await config.update("hover.enabled", true, vscode.ConfigurationTarget.Global)
    const skillUri = vscode.Uri.joinPath(workspace, "SKILL.md")
    await vscode.workspace.fs.writeFile(
      skillUri,
      new TextEncoder().encode("---\nname: reading-helper\ndescription: >\n  Read the complete field.\n  Keep its context.\n---\n\n# Reading helper")
    )
    let skill = await vscode.workspace.openTextDocument(skillUri)
    skill = await vscode.languages.setTextDocumentLanguage(skill, "skill")
    await vscode.window.showTextDocument(skill, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === skillUri.toString(), "skill focus")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => controller.browse.inspect(skillUri)?.units.length === 5, "frontmatter translation")
    assert(
      controller.browse.inspect(skillUri)!.units.some((unit) => unit.content === "Read the complete field. Keep its context.\n"),
      "Multiline scalar was split."
    )
    const fieldHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", skillUri, new vscode.Position(3, 5))
    assert(
      fieldHovers.some(
        (hover) =>
          hover.range?.contains(new vscode.Position(3, 5)) &&
          hover.contents.some(
            (content) =>
              typeof content !== "string" &&
              !content.value.includes(">") &&
              content.value.includes("阅读完整字段") &&
              content.value.includes("保留其上下文") &&
              content.value.includes("\n")
          )
      ),
      "Full multiline field translation was lost in hover."
    )
    checks.push("multiline YAML hover keeps the complete translated field")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    checks.push("skill files preserve complete YAML fields in the same production chain")
    checks.push(...(await runEditReuse(workspace, controller, test.origin)))
    cases = await runHostCases(workspace, controller, async () => (await requests()).length)
    checks.push(...cases.map((item) => `${item.id}: host corpus preserves structure, source and cached browse`))
    checks.push(...(await runFeatures(workspace, controller, test.origin)))
  } finally {
    await config.update("profiles", [], vscode.ConfigurationTarget.Global)
  }
  const report = {
    host: "vscode-test-web",
    mode: test.mode,
    vscode: vscode.version,
    bundleHash,
    checks,
    cases,
    visualLayoutVerified: false,
    liveTranslationVerified: false,
    localHttpVerified: true
  }
  const sent = await fetch(test.origin + "/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) })
  assert(sent.ok, "Could not save test report.")
  console.log(`VS Code Web: ${checks.length} checks passed (${test.mode}).`)
}
