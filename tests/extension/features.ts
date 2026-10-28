import { automatic as automaticScope } from "../../src/host/configuration.ts"
import { prepareTranslation } from "../../src/documents/terms.ts"
import { projectionContent } from "../../src/documents/projection.ts"
import { validateTranslation } from "../../src/documents/validation.ts"
import * as vscode from "vscode"
import { writePreserveTerm } from "../../src/host/addPreserveTerm.ts"
import { parseTermFile } from "../../src/documents/termFiles.ts"
import { markdownPreviewUri } from "../../src/features/preview.ts"
import { displayTranslations, previewLoadingMarker, translationDisplayText } from "../../src/documents/presentation.ts"
import { defaultSystemPrompt } from "../../src/translation/providers/prompts.ts"
import type { Application } from "../../src/host/application.ts"

interface RequestRecord {
  readonly cancelled?: boolean
  readonly provider?: string
  readonly model?: string
  readonly authenticated?: boolean
  readonly customPrompts?: boolean
  readonly customLanguage?: boolean
  readonly target?: string
  readonly count?: number
  readonly sourceDeclared?: boolean
  readonly inputFingerprint?: string
  readonly itemFingerprints?: readonly string[]
  readonly referenceIncluded?: boolean
  readonly contextCharacters?: number
  readonly contextFingerprint?: string
  readonly inputCharacters?: number
  readonly retryFeedbackIncluded?: boolean
  readonly retryFeedbackCompact?: boolean
  readonly retryFeedbackEnglishSeparated?: boolean
  readonly previousOutputFingerprint?: string
  readonly numberedCorrections?: boolean
  readonly messageFingerprint?: string
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error("Feature timed out: " + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function values(hovers: readonly vscode.Hover[]): string {
  return hovers.flatMap((hover) => hover.contents.map((content) => (typeof content === "string" ? content : content.value))).join("\n")
}

async function requestFingerprint(source: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

export async function runFeatures(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const checks: string[] = []
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const requests = async () => ((await (await fetch(origin + "/state")).json()) as { requests: RequestRecord[] }).requests

  async function updateObserved(key: string, value: unknown): Promise<void> {
    let subscription: vscode.Disposable
    const changed = new Promise<void>((resolve) => {
      subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("commentTranslatePlus." + key)) return
        resolve()
      })
    })
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global)
      await changed
    } finally {
      subscription!.dispose()
    }
  }

  async function open(file: string, language: string, text: string): Promise<{ document: vscode.TextDocument; editor: vscode.TextEditor }> {
    const uri = vscode.Uri.joinPath(workspace, file)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
    let document = await vscode.workspace.openTextDocument(uri)
    if (document.languageId !== language) document = await vscode.languages.setTextDocumentLanguage(document, language)
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document === document, file + " focus")
    return { document, editor }
  }

  async function start(document: vscode.TextDocument, count: number): Promise<void> {
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const editor = vscode.window.visibleTextEditors.find((editor) => editor.document === document)
    assert(editor, "Source editor is not visible for browsing.")
    for (const unit of (await owner.documents.parse(document)).groups.flatMap((group) => group.units)) {
      const position = document.positionAt(unit.start)
      if (!editor.visibleRanges.some((range) => range.contains(position))) editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop)
      try {
        await waitFor(() => owner.browse.inspect(document.uri)?.units.some((translated) => translated.id === unit.id) ?? false, document.uri.path + " visible unit")
      } catch (error) {
        throw Error(String(error) + " · unit=" + unit.id + " · state=" + JSON.stringify(owner.browse.inspect(document.uri)))
      }
    }
    await waitFor(() => owner.browse.inspect(document.uri)?.status === "ready" && owner.browse.inspect(document.uri)?.units.length === count, document.uri.path + " browse")
  }

  await config.update(
    "profiles",
    [
      { id: "test", name: "OpenAI A", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "model-a", apiKey: "mock-test" },
      {
        id: "other",
        name: "OpenAI B",
        provider: "openai",
        apiUrl: origin + "/v1/chat/completions",
        model: "model-b",
        apiKey: "mock-test",
        systemPrompt: "Use concise terminology.\n" + defaultSystemPrompt
      },
      { id: "public", name: "No key", provider: "openai", apiUrl: origin + "/public/v1/chat/completions", model: "public-model", apiKey: "" },
      { id: "google", name: "Google fixture", provider: "google", apiUrl: origin + "/google" },
      { id: "bing", name: "Bing fixture", provider: "bing", apiUrl: origin + "/bing/translator" },
      { id: "unchanged", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "unchanged-fixture", apiKey: "mock-test" },
      {
        id: "custom",
        provider: "openai",
        apiUrl: origin + "/v1/chat/completions",
        model: "custom-template",
        apiKey: "mock-test",
        systemPrompt: "",
        userPrompt: "To ${targetLang} (${targetLangCode})\n[[custom-source]]\n${content}\n[[/custom-source]]",
        languageNames: { "zh-CN": "自定义中文名称", "zh-TW": "Traditional Chinese" }
      }
    ],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  await config.update("hover.strings", true, vscode.ConfigurationTarget.Global)
  await config.update("maxRequestsPerSecond", 100, vscode.ConfigurationTarget.Global)

  const wholeSource = Array.from({ length: 8 }, (_, index) => "Read the original document. Section " + (index + 1) + ".").join("\n".repeat(30))
  const whole = await open("whole-document.md", "markdown", wholeSource)
  const wholeUnits = (await owner.documents.parse(whole.document)).groups.flatMap((group) => group.units)
  assert(!whole.editor.visibleRanges.some((range) => range.contains(whole.document.positionAt(wholeUnits.at(-1)!.start))), "Whole-document fixture must extend beyond the viewport.")
  await vscode.commands.executeCommand("commentTranslatePlus.translateAll")
  await waitFor(
    () => owner.browse.inspect(whole.document.uri)?.status === "ready" && owner.browse.inspect(whole.document.uri)?.units.length === wholeUnits.length,
    "whole-document translation without scrolling"
  )
  assert(whole.document.getText() === wholeSource && !whole.document.isDirty, "Whole-document translation changed source.")
  const afterWhole = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.translateAll")
  await waitFor(() => owner.browse.inspect(whole.document.uri)?.status === "ready", "cached whole-document translation")
  assert((await requests()).length === afterWhole, "Repeated whole-document translation bypassed validated cache.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("whole-document command starts browse and completes offscreen units without scrolling, changing source or repeating validated requests")

  const prioritySettings = { maxConcurrentRequests: config.get<number>("maxConcurrentRequests"), maxItemsPerRequest: config.get<number>("maxItemsPerRequest") }
  await config.update("maxConcurrentRequests", 1, vscode.ConfigurationTarget.Global)
  await config.update("maxItemsPerRequest", 1, vscode.ConfigurationTarget.Global)
  const priorityA = ["Read the original document. Amber.", "Read the original document. Birch.", "Read the original document. Cedar."]
  const priorityB = ["Read the original document. Delta.", "Read the original document. Elm.", "Read the original document. Fern."]
  const background = await open("priority-background.md", "markdown", priorityA.join("\n".repeat(100)))
  const beforePriority = (await requests()).length
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold: true }) })
  let foreground: Awaited<ReturnType<typeof open>> | undefined
  try {
    await vscode.commands.executeCommand("commentTranslatePlus.translateAll")
    await waitFor(async () => (await requests()).length === beforePriority + 1, "background first HTTP held")
    foreground = await open("priority-foreground.md", "markdown", priorityB.join("\n".repeat(100)))
    await vscode.commands.executeCommand("commentTranslatePlus.translateAll")
    const last = new vscode.Range(200, 0, 200, 0)
    foreground.editor.revealRange(last, vscode.TextEditorRevealType.AtTop)
    await waitFor(() => foreground!.editor.visibleRanges.some((range) => range.contains(last)), "foreground last viewport")
    await waitFor(() => owner.browse.inspect(foreground!.document.uri)?.loading.length === 3, "foreground units queued")
    assert(owner.browse.inspect(background.document.uri)?.status === "working", "Switching tabs cancelled background translation.")
    assert((await requests()).length === beforePriority + 1, "Queued work exceeded the shared concurrency limit.")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold: false }) })
  }
  await waitFor(
    () => owner.browse.inspect(background.document.uri)?.units.length === 3 && owner.browse.inspect(foreground!.document.uri)?.units.length === 3,
    "foreground and background complete"
  )
  const orderedPriority = (await requests()).slice(beforePriority)
  const expectedPriority = await Promise.all([priorityA[0], priorityB[2], priorityB[0], priorityB[1], priorityA[1], priorityA[2]].map(requestFingerprint))
  assert(
    JSON.stringify(orderedPriority.flatMap((record) => record.itemFingerprints ?? [])) === JSON.stringify(expectedPriority),
    "HTTP order did not follow viewport, current tab, then background tab."
  )
  assert(
    orderedPriority.every((record) => !record.cancelled),
    "Tab switching or scrolling cancelled submitted HTTP."
  )
  assert(!background.document.isDirty && !foreground!.document.isDirty, "Priority scheduling changed source documents.")
  for (const target of [background, foreground!]) owner.browse.stop(target.document.uri, true)
  for (const [key, value] of Object.entries(prioritySettings)) await config.update(key, value, vscode.ConfigurationTarget.Global)
  checks.push("tab switching keeps background translation alive while actual HTTP follows the latest viewport, current tab and other tabs without editing source")

  const code =
    '// Read the original document.\nconst url = "https://example.com";\nconst value = "Read the original document.";\nconst template = `Read the original document. ${sourceId}\\n`;\n/**\n * Keep `sourceId` unchanged.\n */\nconst untouched = 1;'
  const typescript = await open("comments-and-strings.ts", "typescript", code)
  const beforeComments = (await requests()).length
  await start(typescript.document, 2)
  const commentRequest = (await requests()).slice(beforeComments)
  assert(
    commentRequest.length === 1 && commentRequest[0].inputFingerprint === (await requestFingerprint("Read the original document.\n\n%%\n\nKeep `sourceId` unchanged.")),
    "Comment delimiters or documentation stars reached the translation body."
  )
  assert(
    owner.browse.inspect(typescript.document.uri)!.units.some((unit) => unit.translation === "/**\n * 保留 `sourceId` unchanged.\n */"),
    "Documentation comment syntax was not restored locally."
  )
  assert(
    owner.browse.inspect(typescript.document.uri)!.units.every((unit) => unit.text.startsWith("//") || unit.text.startsWith("/**")),
    "Immersive browse translated executable code or strings."
  )
  assert(typescript.document.getText() === code && !typescript.document.isDirty, "Code browse modified source.")
  const beforeBlock = (await requests()).length
  const preservedComment = owner.browse.inspect(typescript.document.uri)!.units[1]
  typescript.editor.selection = new vscode.Selection(0, 4, 0, 4)
  assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.retranslateBlock"), "Cursor block retranslation was not accepted.")
  assert(
    owner.browse.inspect(typescript.document.uri)!.units.some((unit) => unit === preservedComment),
    "Block retranslation discarded its neighbour."
  )
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.status === "ready", "cursor block retranslation")
  const blockRequests = (await requests()).slice(beforeBlock)
  assert(
    blockRequests.length === 1 && blockRequests[0].count === 1 && blockRequests[0].inputFingerprint === (await requestFingerprint("Read the original document.")),
    "Block retranslation did not bypass only the cursor target cache."
  )
  assert(typescript.document.getText() === code && !typescript.document.isDirty, "Block retranslation modified source.")
  checks.push("browse cursor retranslation forces only the selected comment and preserves its neighbour and source")
  const beforeLogLevel = (await requests()).length
  for (const level of ["warning", "error", "info"]) await config.update("logLevel", level, vscode.ConfigurationTarget.Global)
  for (const details of [true, false]) await config.update("logDetails", details, vscode.ConfigurationTarget.Global)
  assert((await requests()).length === beforeLogLevel, "Changing log verbosity started translation or invalidated cache.")
  checks.push("native info/warning/error log configuration changes verbosity without restarting translation or clearing cache")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const beforeDisabledBlock = (await requests()).length
  assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.retranslateBlock"), "Block translation required document browse mode.")
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.status === "ready", "manual block translation")
  const manual = owner.browse.inspect(typescript.document.uri)!
  assert(manual.scope === "blocks" && manual.units.length === 1, "Manual block translation enabled document browse or translated a neighbour.")
  const manualRequests = (await requests()).slice(beforeDisabledBlock)
  assert(manualRequests.length === 1 && manualRequests[0].count === 1, "Manual block translation did not refresh only its target.")
  const manualLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", typescript.document.uri, 10)
  assert(
    manualLenses?.some((lens) => lens.range.start.line === 1),
    "Manual block translation did not reserve a display row."
  )
  owner.browse.refreshVisible()
  assert((await requests()).length === beforeDisabledBlock + 1, "Viewport refresh expanded manual block translation.")
  typescript.editor.selection = new vscode.Selection(5, 5, 5, 5)
  assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.retranslateBlock"), "A second manual block was rejected.")
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.status === "ready", "second manual block translation")
  assert(owner.browse.inspect(typescript.document.uri)!.units[0] === manual.units[0], "A second manual block discarded the first translation.")
  assert(owner.browse.inspect(typescript.document.uri)!.units.length === 2, "Manual blocks did not accumulate.")
  await vscode.commands.executeCommand("commentTranslatePlus.cancel")
  assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.retranslateBlock"), "Explicit block translation did not resume after cancellation.")
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.status === "ready", "manual block after cancellation")
  assert(owner.browse.inspect(typescript.document.uri)!.units.length === 1, "Resuming a manual block translated unrelated blocks.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.units.length === 2, "expand manual blocks to document browse")
  assert(owner.browse.inspect(typescript.document.uri)!.scope === "document", "Enabling browse mode only cleared manual translations.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  assert(!owner.browse.inspect(typescript.document.uri), "Closing browse left manual translations behind.")
  assert(typescript.document.getText() === code && !typescript.document.isDirty, "Manual block translation modified source.")
  checks.push("manual blocks translate and display without document browse, accumulate independently and resume only the explicit target after cancellation")
  checks.push("manual block display expands explicitly to document browse and closes through the existing toggle")
  const beforeStop = (await requests()).length
  const comment = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", typescript.document.uri, new vscode.Position(0, 5))
  assert(values(comment).includes("阅读原始文档") && (await requests()).length === beforeStop, "Independent comment hover did not reuse browse cache.")
  const string = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", typescript.document.uri, new vscode.Position(2, 20))
  assert(values(string).includes("阅读原始文档") && !owner.browse.inspect(typescript.document.uri), "String hover required immersive browse.")
  const template = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", typescript.document.uri, new vscode.Position(3, 23))
  const translatedTemplate = template
    .flatMap((hover) => hover.contents)
    .flatMap((content) => (typeof content !== "string" && content.value.trimStart().startsWith("```") ? [content.value] : []))
    .join("\n")
  assert(
    translatedTemplate.includes("阅读原始文档") && translatedTemplate.includes("${sourceId}") && translatedTemplate.includes("\\n"),
    "Template interpolation or escape sequences were translated."
  )
  const phrase = "Read the original document."
  const startColumn = typescript.document.lineAt(2).text.indexOf(phrase)
  typescript.editor.selection = new vscode.Selection(2, startColumn, 2, startColumn + phrase.length)
  const selected = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", typescript.document.uri, new vscode.Position(2, startColumn + 5))
  assert(values(selected).includes("阅读原始文档"), "Nonempty selection was not translated by hover.")
  typescript.editor.selection = new vscode.Selection(7, 0, 7, 0)
  checks.push("TextMate identifies TypeScript line/block documentation comments and independent string/selection hover without source changes")
  const javascript = await open("comments-and-strings.js", "javascript", code)
  const beforeJavaScript = (await requests()).length
  await start(javascript.document, 2)
  assert((await requests()).length === beforeJavaScript + 1, "Different source-language references reused an incompatible unit cache.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("JavaScript grammar preserves comments while differing language references isolate its unit cache from TypeScript")

  await vscode.window.showTextDocument(typescript.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await config.update("hover.strings", false, vscode.ConfigurationTarget.Global)
  await config.update("browse.comments", false, vscode.ConfigurationTarget.Global)
  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  await start(typescript.document, 3)
  const strings = owner.browse.inspect(typescript.document.uri)!.units
  assert(
    strings.every((unit) => unit.kind === "string"),
    "String-only browse included comments or executable code."
  )
  assert(
    strings.some((unit) => unit.translation === "`阅读原始文档。 ${sourceId}\\n`"),
    "Immersive strings lost quotes, escapes or interpolation."
  )
  assert(
    strings.some((unit) => unit.translation === '"https://example.com"'),
    "String browse changed a URL."
  )
  await config.update("browse.comments", true, vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.status === "ready" && owner.browse.inspect(typescript.document.uri)?.units.length === 5, "mixed comments and strings")
  const beforeKindToggle = (await requests()).length
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(typescript.document.uri)?.units.length === 2, "hide string browse")
  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  await waitFor(
    () => owner.browse.inspect(typescript.document.uri)?.status === "ready" && owner.browse.inspect(typescript.document.uri)?.units.length === 5,
    "restore cached string browse"
  )
  assert((await requests()).length === beforeKindToggle, "Toggling code browse kinds discarded compatible cached results.")
  assert(typescript.document.getText() === code && !typescript.document.isDirty, "String browse modified source or undo state.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  await config.update("hover.strings", true, vscode.ConfigurationTarget.Global)
  checks.push("comment and string browse switches are independent of hover, preserve literal syntax and reuse cache when restored")

  const rustSource = '/// Read the original document.\nfn main() {\n    /* Keep `sourceId` unchanged. */\n    let message = "Read the original document.";\n    let untouched = 1;\n}\n'
  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  const rust = await open("merged-reference.rs", "rust", rustSource)
  const beforeRust = (await requests()).length
  await start(rust.document, 3)
  const rustRequests = (await requests()).slice(beforeRust)
  assert(
    rustRequests.length === 1 && rustRequests[0].count === 3 && rustRequests[0].contextCharacters === rustSource.trimEnd().length,
    "Rust source windows were duplicated or split into multiple requests."
  )
  assert(
    rustRequests[0].inputFingerprint === (await requestFingerprint("Read the original document.\n\n%%\n\nKeep `sourceId` unchanged.\n\n%%\n\nRead the original document.")),
    "Rust block delimiters reached the translation body."
  )
  assert(
    owner.browse.inspect(rust.document.uri)!.units.some((unit) => unit.translation === "/* 保留 `sourceId` unchanged. */"),
    "Rust block comment delimiters were not restored."
  )
  assert(rust.document.getText() === rustSource && !rust.document.isDirty, "Merging source context modified the Rust source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("Rust browse merges overlapping comment/string references into the original source once without source edits")

  const quotedTableSource = "> | Label | Value |\r\n> | --- | --- |\r\n> | Read the original document. | Keep `sourceId` unchanged. |\r\n"
  const quotedTable = await open("quoted-crlf-table.md", "markdown", quotedTableSource)
  const beforeQuotedTable = (await requests()).length
  await start(quotedTable.document, 4)
  const quotedTableRequests = (await requests()).slice(beforeQuotedTable)
  assert(
    quotedTableRequests.length === 1 && quotedTableRequests[0].count === 4 && quotedTableRequests[0].contextCharacters === quotedTableSource.trimEnd().length,
    "CRLF quoted tables lost their raw header, delimiter or row context."
  )
  assert(
    owner.browse.inspect(quotedTable.document.uri)!.units.some((unit) => unit.translation.includes("阅读原始文档")),
    "CRLF table cells did not pass the formal translation chain."
  )
  assert(quotedTable.document.getText() === quotedTableSource && !quotedTable.document.isDirty, "CRLF table browse modified source syntax or line endings.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("CRLF quoted tables translate independent cells with one complete raw reference and unchanged source offsets")

  const delayed = await open("delayed-hover.ts", "typescript", 'const delayed = "Keep another string.";')
  const control = (hold: boolean) => fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold }) })
  const beforeDelayed = (await requests()).length
  await control(true)
  try {
    const pending = vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", delayed.document.uri, new vscode.Position(0, 23))
    await waitFor(async () => (await requests()).length > beforeDelayed, "independent hover request")
    await config.update("activeProfile", "other", vscode.ConfigurationTarget.Global)
    await control(false)
    assert(!values(await pending).includes("[注释翻译+]"), "A late independent hover survived a profile change.")
  } finally {
    await control(false)
    await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  }
  checks.push("profile changes cancel independent hover requests before late responses can appear")

  const cancellationSource = "Read the original document. HoverCancelFirst\n\nKeep the other paragraph. HoverCancelSecond"
  const cancellation = await open("hover-cancellation.md", "markdown", cancellationSource)
  const cancellationStart = (await requests()).length
  await control(true)
  try {
    const first = vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", cancellation.document.uri, new vscode.Position(0, 6))
    await waitFor(async () => (await requests()).length === cancellationStart + 1, "first hover target request")
    const second = vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", cancellation.document.uri, new vscode.Position(2, 6))
    await waitFor(async () => (await requests())[cancellationStart]?.cancelled === true && (await requests()).length === cancellationStart + 2, "different hover target cancels old HTTP")
    assert(!values(await first).includes("[注释翻译+]"), "A different source target retained the old hover result.")
    await vscode.commands.executeCommand("commentTranslatePlus.cancel")
    await waitFor(async () => (await requests())[cancellationStart + 1]?.cancelled === true, "explicit hover cancellation aborts HTTP")
    assert(!values(await second).includes("[注释翻译+]"), "Explicit cancellation still returned translated hover content.")
    const edited = vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", cancellation.document.uri, new vscode.Position(0, 6))
    await waitFor(async () => (await requests()).length === cancellationStart + 3, "hover before document edit")
    assert(await cancellation.editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "Changed. ")), "Hover invalidation edit failed.")
    await waitFor(async () => (await requests())[cancellationStart + 2]?.cancelled === true, "document edit cancels hover HTTP")
    assert(!values(await edited).includes("[注释翻译+]"), "Edited source retained an old hover result.")
  } finally {
    await control(false)
  }
  assert(cancellation.document.getText() === "Changed. " + cancellationSource, "Hover cancellation changed the source.")
  checks.push("different hover targets, explicit cancellation and source edits abort pending HTTP and never return stale hover content")

  const pythonSource = '# Read the original document.\nvalue = "Keep the original string."'
  const python = await open("comments.py", "python", pythonSource)
  await start(python.document, 1)
  assert(owner.browse.inspect(python.document.uri)!.units[0].text.startsWith("#"), "Python grammar did not isolate its comment.")
  assert(python.document.getText() === pythonSource && !python.document.isDirty, "Python browse modified code.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("installed Python grammar supports comment browse and leaves executable code unchanged")

  const jsonContent =
    "<example_catalog_snapshot>\nThis is a sample museum catalog prepared for the spring exhibition.\n<sample_location>\nEurope/London\n</sample_location>\n</example_catalog_snapshot>"
  const longData = "0123456789abcdef0123456789abcdef 2001:0db8:85a3:0000:0000:8a2e:0370:7334"
  for (const [file, content, markers] of [
    ["native-labels.json", jsonContent, false],
    ["long-data.json", "Read the original document. " + longData, true]
  ] as const) {
    const source = JSON.stringify({ content })
    const target = await open(file, "json", source)
    const parsed = await owner.documents.parse(target.document, true)
    const unit = parsed.groups.flatMap((group) => group.units).find((unit) => unit.content === content)
    assert(unit, "Real JSON grammar lost the decoded string value.")
    const prepared = prepareTranslation(unit, 32)
    assert(prepared.hasMarkers === markers && !prepared.text.includes("\\n"), "JSON exposed serialization escapes or masked ordinary labels.")
    assert(markers || prepared.text.includes("This is"), "JSON preparation hid This behind an escape marker.")
    const before = (await requests()).length
    const result = await owner.translations.translate(target.document, { units: [unit] }, new AbortController().signal)
    const translated = JSON.parse(result.get(unit.id)!) as string
    assert(
      markers ? translated.includes(longData) && translated.includes("阅读原始文档") : translated.includes("<示例目录快照>"),
      "JSON labels or opaque data did not survive the real request chain."
    )
    const sent = (await requests()).slice(before)
    assert(sent.length === 1 && sent[0].itemFingerprints?.includes(await requestFingerprint(prepared.text)), "JSON sent a different string representation or consumed retries.")
    assert(target.document.getText() === source && !target.document.isDirty, "JSON translation edited its source.")
    if (markers) {
      const previous = config.get<number>("minimumMarkerCharacters")
      await updateObserved("minimumMarkerCharacters", 256)
      try {
        const beforeThreshold = (await requests()).length
        await owner.translations.translate(target.document, { units: [unit] }, new AbortController().signal)
        const nativeFingerprint = await requestFingerprint(content)
        assert(
          (await requests()).slice(beforeThreshold).some((request) => request.itemFingerprints?.includes(nativeFingerprint)),
          "Native threshold settings did not change the request or reused a result from another threshold."
        )
      } finally {
        await updateObserved("minimumMarkerCharacters", previous)
      }
    }
  }
  checks.push("real JSON grammar decodes escapes, translates custom labels and uses CTP only for long hash and IPv6 data over mock HTTP without source edits")

  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  for (const quote of ['"""', "'''"]) {
    const source = quote + "Read the original document.\nKeep the original string.\n" + quote
    const target = await open(quote[0] === '"' ? "docstring-double.py" : "docstring-single.py", "python", source)
    const parsed = await owner.documents.parse(target.document)
    const units = parsed.groups.flatMap((group) => group.units)
    assert(units.length > 0, "Python grammar lost triple quoted strings.")
    for (const unit of units) {
      const prepared = prepareTranslation(unit, 32)
      assert(!prepared.text.includes(quote) && !prepared.hasMarkers, "Python triple quote boundaries consumed model markers.")
      assert(prepared.restore(prepared.text) === unit.text, "Local triple quote restoration changed source content.")
    }
    const singleSource = "    " + quote + "Read the original document." + quote
    const single = (await owner.documents.parseSource(singleSource, "python")).groups.flatMap((group) => group.units)
    assert(single.length === 1 && single[0].text === "Read the original document.", "Single-line docstring source delimiters became prose.")
    const translated = prepareTranslation(single[0], 32).restore("阅读原始文档。")
    assert(translationDisplayText(translated, single[0].format, single[0]) === "阅读原始文档。", "Single-line docstring display included triple quotes.")
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("real Python grammar keeps triple quote boundaries local for both quote styles and multiline docstrings")

  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  {
    const source = 'notice = "Read the original document.\\n\\nRead the original document."\nnext_value = 1'
    const target = await open("decoded-paragraph-row.py", "python", source)
    await start(target.document, 2)
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", target.document.uri, 100)
    assert(lenses?.filter((lens) => lens.range.start.line === 1).length === 1, "Same-line decoded paragraphs reserved multiple translation rows.")
    assert(target.document.getText() === source && !target.document.isDirty, "Decoded paragraph display modified source.")
    const completed = owner.browse.inspect(target.document.uri)!.units
    const rows = displayTranslations(source, completed)
    assert(rows.length === 1 && rows[0].translation === "阅读原始文档。\n\n阅读原始文档。", "Same-line display details lost decoded paragraphs or source order.")
    const second = completed[1]
    const position = target.document.positionAt(second.start + 2)
    target.editor.selection = new vscode.Selection(position, position)
    assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.translateAndReplace"), "Decoded paragraph cursor replacement failed.")
    assert(
      target.document.getText() === source.slice(0, second.start) + second.translation + source.slice(second.end),
      "Decoded paragraph replacement changed a neighbour or its escaped separator."
    )
    assert(target.document.getText().includes("\\n\\n") && target.document.lineCount === 2, "Replacement changed escaped content breaks into physical source lines.")
    await vscode.commands.executeCommand("undo")
    assert(target.document.getText() === source, "Decoded paragraph replacement did not undo exactly.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    checks.push("decoded Python paragraphs retain independent units, one source-line display block, decoded details and escape-preserving cursor replacement")
  }
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "def _locked_skill_notice(name: str) -> str:",
      "    return (",
      "        f\"Skill '{name}' is already loaded and identity-locked in this \"",
      '        "session. The guidance is already in your context — do not "',
      '        "reload it. Continue with the previously loaded skill content."',
      "    )"
    ].join(newline)
    const target = await open("concatenated-" + (newline === "\n" ? "lf.py" : "crlf.py"), "python", source)
    const parsed = await owner.documents.parse(target.document)
    const units = parsed.groups.flatMap((group) => group.units)
    assert(units.length === 1, "Python implicit concatenation was split into incomplete translation items.")
    const unit = units[0]
    assert(unit.text.startsWith("Skill") && unit.text.endsWith("content."), "Python prose range contains an outer delimiter or lost its body.")
    const prepared = prepareTranslation(unit, 32)
    assert(
      prepared.text.startsWith("Skill '") && prepared.text.includes("is already loaded") && prepared.text.includes("session.") && prepared.text.endsWith("skill content."),
      "Python concatenation did not send the complete sentence."
    )
    assert(prepared.text.includes("{name}") && !prepared.hasMarkers, "Short Python syntax unnecessarily consumed CTP markers.")
    assert(prepared.restore(prepared.text) === unit.text, "Python concatenation no-op changed syntax or line endings.")
    const modified = prepared.restore(prepared.text.replace("Skill", "技能"))
    assert(projectionContent(unit, modified) === unit.projection!.unit.text.replace("Skill", "技能"), "Python translation changed interpolation or prose.")
    assert(validateTranslation(unit, modified) === undefined && !/[\r\n]/u.test(prepared.text), "Python concatenation leaked source layout or failed restoration.")
    const before = (await requests()).length
    await start(target.document, 1)
    const sent = (await requests()).slice(before).flatMap((request) => request.itemFingerprints ?? [])
    assert(sent.length > 0 && sent.every((fingerprint) => fingerprint === sent[0]) && sent[0] === (await requestFingerprint(prepared.text)), "Python HTTP received a partial literal.")
    assert(target.document.getText() === source && !target.document.isDirty, "Python browse modified source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  }
  for (const [expression, count] of [
    ['("Read text." "Keep text.")', 1],
    ['("Read text.", "Keep text.")', 2],
    ['("Read text." + "Keep text.")', 2],
    ['"Read text."\n"Keep text."', 2],
    ['"Read text." \\\n"Keep text."', 2],
    ['(f"Read {shelf[\'name\']} before "\n"visiting the gallery.")', 1],
    ['(f"Read {user.name!r:>10}."\n"Keep text.")', 2]
  ] as const) {
    const parsed = await owner.documents.parseSource(expression, "python")
    const units = parsed.groups.flatMap((group) => group.units)
    assert(units.length === count, "Python concatenation crossed a statement, comma or operator boundary: " + expression)
    for (const unit of units) {
      const prepared = prepareTranslation(unit, 32)
      assert(prepared.restore(prepared.text) === unit.text, "Python expression no-op lost protected syntax.")
      if (unit.text.includes("user.name")) assert(prepared.text.includes("{user.name!r:>10}") && !prepared.hasMarkers, "Short Python interpolation consumed CTP markers.")
      if (expression.includes("shelf[")) {
        const translated = prepared.restore(prepared.text.replace("Read", "阅读"))
        assert(
          validateTranslation(unit, translated) === undefined && projectionContent(unit, translated).includes("{shelf['name']}"),
          "An interpolation's inner quote closed the outer f-string."
        )
      }
    }
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("Python implicit concatenation sends complete f-string prose over HTTP and preserves interpolation and syntax across LF/CRLF without crossing expression boundaries")

  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  for (const quote of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const source = [
        "def museum_notice(exhibits):",
        '    """Read the original document."""',
        '    labels = "\\n".join(f"- **{name}**" for name in exhibits)',
        "    return f" + quote + "Read the original document.",
        "",
        "Available exhibits:",
        "{labels}",
        "",
        "Read the original document. {labels}",
        "Keep both lines together.",
        quote,
        'other = "Keep the original string."'
      ].join(newline)
      const expected = [
        "Read the original document.",
        "{name}",
        "Read the original document.",
        "Available exhibits:",
        "{labels}",
        "Read the original document. {labels} Keep both lines together.",
        "Keep the original string."
      ]
      const target = await open("multiline-fstring-" + (quote[0] === '"' ? "double" : "single") + (newline === "\n" ? "-lf.py" : "-crlf.py"), "python", source)
      const units = (await owner.documents.parse(target.document)).groups.flatMap((group) => group.units)
      assert(
        JSON.stringify(units.map((unit) => prepareTranslation(unit, 32).text)) === JSON.stringify(expected),
        "Multiline f-string prose disappeared at a standalone interpolation or crossed the closing quote."
      )
      const before = (await requests()).length
      await start(target.document, units.length)
      const completed = owner.browse.inspect(target.document.uri)!.units
      const paragraph = completed.find((unit) => unit.text.includes("Read the original document. {labels}"))
      assert(
        paragraph?.translation &&
          validateTranslation(paragraph, paragraph.translation) === undefined &&
          projectionContent(paragraph, paragraph.translation) === "阅读原始文档。 {labels} 保留两行在一起。",
        "Multiline f-string browsing did not translate complete prose while preserving the interpolation."
      )
      const sent = (await requests()).slice(before).flatMap((request) => request.itemFingerprints ?? [])
      const allowed = await Promise.all(expected.map(requestFingerprint))
      assert(
        sent.every((fingerprint) => allowed.includes(fingerprint)),
        "Multiline f-string HTTP received source quote boundaries or incomplete prose."
      )
      assert(target.document.getText() === source && !target.document.isDirty, "Multiline f-string browsing changed source.")
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      for (const prefix of ["fr", "rf", "F"]) {
        const variant = source.replace("return f" + quote, "return " + prefix + quote)
        const parsed = (await owner.documents.parseSource(variant, "python")).groups.flatMap((group) => group.units)
        assert(
          JSON.stringify(parsed.map((unit) => prepareTranslation(unit, 32).text)) === JSON.stringify(expected),
          "A raw or uppercase multiline f-string lost prose around interpolation-only lines."
        )
      }
    }
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("real Python multiline f-strings retain paragraphs around standalone and inline interpolations, translate over mock HTTP and keep source intact for both quotes and LF/CRLF")

  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  for (const quote of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const source = ["def search():", "    " + quote + "Read the original document.", "", "        Args:", "            Read the original document.", "    " + quote, "    return 1"].join(
        newline
      )
      const target = await open("indented-docstring-" + (quote[0] === '"' ? "double" : "single") + (newline === "\n" ? "-lf.py" : "-crlf.py"), "python", source)
      const parsed = await owner.documents.parse(target.document)
      const units = parsed.groups.flatMap((group) => group.units)
      const before = (await requests()).length
      await start(target.document, units.length)
      const translated = owner.browse.inspect(target.document.uri)!.units
      assert(
        translated.every((unit) => unit.translation === unit.text.replaceAll("Read the original document.", "阅读原始文档。")),
        "Docstring translation lost source indentation or boundaries."
      )
      const args = translated.find((unit) => unit.text.includes("Args:"))
      assert(args && args.translation === args.text, "Unchanged docstring label was not completed as the exact source.")
      assert(!displayTranslations(source, translated).some((row) => row.text.includes("Args:")), "Unchanged indented label produced a duplicate translation row.")
      const sent = (await requests()).slice(before).flatMap((request) => request.itemFingerprints ?? [])
      const allowed = await Promise.all(["Read the original document.", "Args:"].map(requestFingerprint))
      assert(sent.length > 0 && sent.every((fingerprint) => allowed.includes(fingerprint)), "Docstring indentation or quote syntax leaked into model prose.")
      const afterBrowse = (await requests()).length
      const offset = source.lastIndexOf("Read the original document.") + 3
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", target.document.uri, target.document.positionAt(offset))
      assert(values(hover).includes("            阅读原始文档。"), "Docstring hover lost continuation indentation.")
      assert((await requests()).length === afterBrowse, "Docstring hover did not reuse the restored browse result.")
      assert(target.document.getText() === source && !target.document.isDirty, "Docstring browse or hover modified source.")
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      const position = target.document.positionAt(offset)
      target.editor.selection = new vscode.Selection(position, position)
      assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.translateAndReplace"), "Docstring cursor replacement failed.")
      assert(
        target.document.getText() ===
          source.slice(0, source.lastIndexOf("Read the original document.")) +
            source.slice(source.lastIndexOf("Read the original document.")).replace("Read the original document.", "阅读原始文档。"),
        "Docstring replacement changed indentation, neighbouring text or line endings."
      )
      assert((await requests()).length === afterBrowse, "Docstring replacement discarded the validated cache.")
      await vscode.commands.executeCommand("undo")
      assert(target.document.getText() === source, "Docstring replacement did not undo in one step.")
    }
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("Python docstring indentation survives browse, unchanged-label suppression, cached hover and undoable cursor replacement for both quotes and LF/CRLF")

  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "def museum_catalog():",
      '    """Read the original document.',
      "",
      "    Read the original",
      "    document.",
      "",
      "    - Read the original",
      "      document.",
      "    - Read the original document.",
      "    1. Read the original",
      "       document.",
      "    2. Read the original document.",
      "",
      "    Args:",
      "        shelf: Read the original",
      "            document.",
      "        limit: Read the original document.",
      "",
      "    Example:",
      '        museum_catalog(shelf="fiction", limit=4)',
      "",
      "    Returns:",
      "        Read the original document.",
      '    """'
    ].join(newline)
    const target = await open("museum-prose-" + (newline === "\n" ? "lf.py" : "crlf.py"), "python", source)
    const parsed = await owner.documents.parse(target.document)
    const units = parsed.groups.flatMap((group) => group.units)
    const expected = [
      "Read the original document.",
      "Read the original document.",
      "Read the original document.",
      "Read the original document.",
      "Read the original document.",
      "Read the original document.",
      "Args:",
      "shelf: Read the original document.",
      "limit: Read the original document.",
      "Example:",
      "Returns:",
      "Read the original document."
    ]
    assert(
      JSON.stringify(units.map((unit) => prepareTranslation(unit, 32).text)) === JSON.stringify(expected),
      "Real Python grammar split prose continuations or merged list/field boundaries."
    )
    const before = (await requests()).length
    await start(target.document, units.length)
    const completed = owner.browse.inspect(target.document.uri)!.units
    assert(
      completed.every((unit) => unit.translation !== undefined && validateTranslation(unit, unit.translation) === undefined),
      "Python prose did not complete with valid restored literals."
    )
    const last = completed.at(-1)!
    const rows = displayTranslations(
      source,
      completed.filter((unit): unit is typeof unit & { translation: string } => unit.translation !== undefined)
    )
    assert(
      last.end === source.lastIndexOf(newline + '    """') && rows.every((row) => !row.translation.includes('"""')),
      "Docstring display included closing quotes or placed the final prose row after them."
    )
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", target.document.uri)
    assert(
      lenses?.some((lens) => lens.range.start.line === target.document.positionAt(last.end).line + 1),
      "The final paragraph did not reserve its display row before the closing triple quote."
    )
    const sent = (await requests()).slice(before).flatMap((request) => request.itemFingerprints ?? [])
    const allowed = await Promise.all(expected.map(requestFingerprint))
    assert(sent.length > 0 && sent.every((fingerprint) => allowed.includes(fingerprint)), "Python HTTP received source syntax, partial continuations or executable examples.")
    const after = (await requests()).length
    const offset = source.indexOf("    document.") + 5
    await vscode.commands.executeCommand("vscode.executeHoverProvider", target.document.uri, target.document.positionAt(offset))
    assert((await requests()).length === after, "A continuation-line hover did not reuse its complete paragraph.")
    assert(target.document.getText() === source && !target.document.isDirty, "Paragraph/list browsing modified Python source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const position = target.document.positionAt(offset)
    target.editor.selection = new vscode.Selection(position, position)
    assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.translateAndReplace"), "Continuation-line paragraph replacement failed.")
    assert(
      target.document.getText() === source.replace("    Read the original" + newline + "    document.", "    阅读原始文档。"),
      "Paragraph replacement changed a label, list, example or neighbouring paragraph."
    )
    await vscode.commands.executeCommand("undo")
    assert(target.document.getText() === source, "Paragraph replacement did not undo in one step.")
  }
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("Python prose paragraphs and ordered/unordered list and parameter continuations share requests, cache, hover and undoable replacement without translating examples")

  await vscode.window.showTextDocument(typescript.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await config.update("hover.documentation", true, vscode.ConfigurationTarget.Global)
  const originalHover = new vscode.MarkdownString("Read the original document.")
  const provider = vscode.languages.registerHoverProvider("typescript", { provideHover: () => new vscode.Hover(originalHover, new vscode.Range(0, 0, 0, 29)) })
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", typescript.document.uri, new vscode.Position(0, 5))
    const content = values(hovers)
    assert(content.includes("Read the original document.") && content.includes("阅读原始文档"), "Other providers were replaced, lost or not translated.")
    assert(originalHover.value === "Read the original document.", "Translation mutated another provider hover.")
  } finally {
    provider.dispose()
  }
  await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  checks.push("other language-service hover remains intact while translated documentation is added without recursive requests")

  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, "cover.svg"), new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'))
  const markdownSource = "1. Read the original document.\n2. Keep `sourceId` and [guide](https://example.com) and ![cover](./cover.svg)."
  const profile = await open("profile-switch.md", "markdown", markdownSource)
  const beforeLinks = (await requests()).length
  await start(profile.document, 2)
  const linkFingerprint = await requestFingerprint("Keep `sourceId` and [guide](https://example.com) and ![cover](./cover.svg).")
  assert(
    (await requests()).slice(beforeLinks).some((request) => request.itemFingerprints?.includes(linkFingerprint)),
    "The desktop host masked short code or link targets."
  )
  checks.push("short code, links and images reach HTTP in native syntax without CTP markers")
  const beforeSwitch = (await requests()).length
  await config.update("activeProfile", "other", vscode.ConfigurationTarget.Global)
  await waitFor(async () => owner.browse.inspect(profile.document.uri)?.status === "ready" && (await requests()).at(-1)?.model === "model-b", "model switch")
  assert((await requests()).length === beforeSwitch + 1, "Model switch reused an incompatible response.")
  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(profile.document.uri)?.status === "ready" && owner.browse.inspect(profile.document.uri)?.units.length === 2, "profile cache restore")
  assert((await requests()).length === beforeSwitch + 1, "Switching back discarded valid profile cache.")
  await config.update("activeProfile", "public", vscode.ConfigurationTarget.Global)
  await waitFor(async () => owner.browse.inspect(profile.document.uri)?.status === "ready" && (await requests()).at(-1)?.model === "public-model", "empty key profile")
  assert((await requests()).at(-1)?.authenticated === false, "Empty settings key sent Authorization.")
  checks.push("profile and prompt changes isolate results; switching back reuses cache and empty settings keys omit authentication")
  for (const provider of ["google", "bing"]) {
    await config.update("activeProfile", provider, vscode.ConfigurationTarget.Global)
    await waitFor(
      async () =>
        owner.browse.inspect(profile.document.uri)?.status === "ready" &&
        owner.browse.inspect(profile.document.uri)?.units.length === 2 &&
        (await requests()).at(-1)?.provider === provider,
      provider + " protocol"
    )
    assert(
      owner.browse.inspect(profile.document.uri)!.units[1].translation.includes("`sourceId`") &&
        owner.browse.inspect(profile.document.uri)!.units[1].translation.includes("[guide](https://example.com)") &&
        owner.browse.inspect(profile.document.uri)!.units[1].translation.includes("![cover](./cover.svg)"),
      provider + " changed protected content."
    )
  }
  checks.push("Google and Bing use their own HTTP protocols and preserve code/link placeholders in the desktop host")
  const beforeMode = (await requests()).length
  await config.update("displayMode", "inplace", vscode.ConfigurationTarget.Global)
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", profile.document.uri)
  assert(
    !lenses.some((lens) => lens.command?.title === " ") && profile.document.getText() === markdownSource && !profile.document.isDirty,
    "Inplace mode left contrast rows or modified source."
  )
  await config.update("displayMode", "contrast", vscode.ConfigurationTarget.Global)
  assert((await requests()).length === beforeMode, "Display mode changes restarted network translation.")
  checks.push("contrast/inplace switching preserves source and cache without making HTTP requests")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  const beforePreview = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.preview")
  let preview: vscode.TextDocument | undefined
  await waitFor(() => {
    preview = vscode.workspace.textDocuments.find((document) => document.uri.scheme === "comment-translate-plus-preview" && document.uri.path === profile.document.uri.path)
    return !!preview?.getText().includes("阅读原始文档") && !preview.getText().includes("正在翻译")
  }, "native Markdown preview")
  assert((await requests()).length === beforePreview, "Preview discarded the shared browse cache.")
  assert(profile.document.getText() === markdownSource && !profile.document.isDirty && !preview!.isDirty, "Preview modified a document.")
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>'
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, "preview.svg"), new TextEncoder().encode(image))
  const imageUri = preview!.uri.with({ path: preview!.uri.path.replace(/[^/]+$/, "preview.svg") })
  assert(new TextDecoder().decode(await vscode.workspace.fs.readFile(imageUri)) === image, "Preview relative resources did not map to the original filesystem.")
  let writeRejected = false
  try {
    await vscode.workspace.fs.writeFile(preview!.uri, new TextEncoder().encode("Must not write."))
  } catch {
    writeRejected = true
  }
  assert(writeRejected && profile.document.getText() === markdownSource, "Preview filesystem allowed writes.")
  const previewNeighbor = await open("preview-refresh-neighbor.md", "markdown", "Keep this different preview neighbor unchanged.")
  await start(previewNeighbor.document, 1)
  const beforePreviewRefresh = (await requests()).length
  await control(true)
  try {
    await vscode.commands.executeCommand("commentTranslatePlus.retranslatePreview", preview!.uri)
    await waitFor(async () => (await requests()).length > beforePreviewRefresh && preview!.getText().includes(previewLoadingMarker), "forced preview request and loading state")
    const refreshedRequests = (await requests()).slice(beforePreviewRefresh)
    assert(refreshedRequests.length === 1 && refreshedRequests[0].count === 2, "Preview refresh translated the focused neighbor or duplicated its request.")
    assert(owner.browse.inspect(previewNeighbor.document.uri)?.status === "ready", "Preview refresh restarted a different active source.")
  } finally {
    await control(false)
  }
  await waitFor(() => preview!.getText().includes("阅读原始文档") && !preview!.getText().includes(previewLoadingMarker), "forced preview completion")
  const afterPreviewRefresh = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.retranslatePreview", previewNeighbor.document.uri)
  assert((await requests()).length === afterPreviewRefresh, "A non-preview URI triggered preview retranslation.")
  assert(profile.document.getText() === markdownSource && !profile.document.isDirty && !preview!.isDirty, "Preview refresh wrote source or translation files.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("preview retranslation bypasses cached source results, shows loading, preserves readonly files and never refreshes another focused document")
  const previewSourceEditor = await vscode.window.showTextDocument(profile.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  assert(await previewSourceEditor.edit((builder) => builder.replace(new vscode.Range(0, 3, 0, 30), "Keep the revised document.")), "Preview source edit failed.")
  await waitFor(() => !!preview?.getText().includes("保留 the revised document.") && !preview.getText().includes("正在翻译"), "preview source refresh")
  assert(!preview!.getText().includes("阅读原始文档"), "Preview retained an obsolete source translation.")
  const previewTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === preview!.uri.toString())
  assert(previewTabs.length === 1, "Translation did not open one native preview tab.")
  await vscode.window.tabGroups.close(previewTabs)
  await profile.document.save()
  const restoredSource = vscode.Uri.joinPath(workspace, "restored-preview.md")
  await vscode.workspace.fs.writeFile(restoredSource, new TextEncoder().encode(markdownSource))
  const restored = await vscode.workspace.openTextDocument(markdownPreviewUri(restoredSource))
  await waitFor(() => restored.getText().includes("阅读原始文档") && !restored.getText().includes("正在翻译"), "restored virtual preview")
  assert(!restored.isDirty, "Restoring a preview made it dirty.")
  checks.push("native translated Markdown preview shares cache, refreshes edits, restores from its URI and delegates relative resources through a read-only filesystem")
  const termsFile = vscode.Uri.joinPath(workspace, "custom-terms.json")
  const unconfiguredFile = vscode.Uri.joinPath(workspace, "unconfigured-terms.jsonc")
  await vscode.workspace.fs.writeFile(unconfiguredFile, new TextEncoder().encode('[\n// User rules\n{"pattern":"HTTP", "flags":"i"},\n]\n'))
  const configuredBeforeAdd = JSON.stringify(config.inspect("preserveTerms"))
  const rulesBeforeAdd = (await owner.translations.settings(profile.document.uri)).preserveTerms.identity
  for (const extension of ["json", "jsonc"]) {
    const newPath = "./new-term-files/" + extension + "/terms." + extension
    const newFile = vscode.Uri.joinPath(workspace, newPath)
    await config.update("preserveTermsWriteFile", newPath, vscode.ConfigurationTarget.Global)
    let emptyRejected = false
    try {
      await writePreserveTerm(profile.document.uri, " ")
    } catch {
      emptyRejected = true
    }
    let exists = true
    try {
      await vscode.workspace.fs.stat(newFile)
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error
      exists = false
    }
    assert(emptyRejected && !exists, "An invalid term created a file before validation.")
    assert(await writePreserveTerm(profile.document.uri, 'New "term"'), "A missing target file was not created.")
    assert(await writePreserveTerm(profile.document.uri, "SecondTerm"), "Appending to the newly created target failed.")
    assert(!(await writePreserveTerm(profile.document.uri, "secondterm")), "A new target accepted a duplicate term with different casing.")
    const created = new TextDecoder().decode(await vscode.workspace.fs.readFile(newFile))
    assert(JSON.stringify(parseTermFile(created, newFile.toString())) === JSON.stringify(['New "term"', "SecondTerm"]), "Creating or reusing the target lost literal values.")
    const createdDocument = await vscode.workspace.openTextDocument(newFile)
    assert(!createdDocument.isDirty, "The automatically created term file was not saved.")
  }
  const directoryTarget = vscode.Uri.joinPath(workspace, "directory-target.json")
  await vscode.workspace.fs.createDirectory(directoryTarget)
  await config.update("preserveTermsWriteFile", directoryTarget.toString(), vscode.ConfigurationTarget.Global)
  let directoryRejected = false
  try {
    await writePreserveTerm(profile.document.uri, "Must not replace a directory")
  } catch {
    directoryRejected = true
  }
  assert(directoryRejected && (await vscode.workspace.fs.stat(directoryTarget)).type === vscode.FileType.Directory, "An unreadable target was treated as a missing file.")
  checks.push("missing JSON/JSONC targets and parent directories are created and saved before subsequent appends; invalid input and existing directories are not overwritten")
  await config.update("preserveTermsWriteFile", "./unconfigured-terms.jsonc", vscode.ConfigurationTarget.Global)
  assert(await writePreserveTerm(profile.document.uri, ' Widget "quoted" '), "Adding to an unconfigured file failed.")
  const addedText = new TextDecoder().decode(await vscode.workspace.fs.readFile(unconfiguredFile))
  assert(addedText.includes("// User rules"), "Adding a literal discarded user comments.")
  assert(
    JSON.stringify(parseTermFile(addedText, unconfiguredFile.toString())) === JSON.stringify([{ pattern: "HTTP", flags: "i" }, ' Widget "quoted" ']),
    "Adding a literal damaged existing rules or literal spelling."
  )
  assert(!(await writePreserveTerm(profile.document.uri, ' Widget "quoted" ')), "Adding an existing literal changed the file.")
  assert(await writePreserveTerm(profile.document.uri, "SecondTerm"), "A second addition did not reuse the configured target.")
  const savedTerms = new TextDecoder().decode(await vscode.workspace.fs.readFile(unconfiguredFile))
  assert(parseTermFile(savedTerms, unconfiguredFile.toString()).includes("SecondTerm"), "The second term was not saved to the configured file.")
  assert(JSON.stringify(config.inspect("preserveTerms")) === configuredBeforeAdd, "Adding to a file silently changed configured sources.")
  assert((await owner.translations.settings(profile.document.uri)).preserveTerms.identity === rulesBeforeAdd, "An unconfigured file affected active preservation rules.")
  const dirtyTerms = await vscode.workspace.openTextDocument(unconfiguredFile)
  const dirtyEdit = new vscode.WorkspaceEdit()
  dirtyEdit.insert(unconfiguredFile, new vscode.Position(0, 0), "// unsaved\n")
  assert(await vscode.workspace.applyEdit(dirtyEdit), "Could not prepare unsaved term edits.")
  let dirtyRejected = false
  try {
    await writePreserveTerm(profile.document.uri, "Another")
  } catch {
    dirtyRejected = true
  }
  assert(dirtyRejected && dirtyTerms.isDirty && dirtyTerms.getText().startsWith("// unsaved"), "Adding a term overwrote or saved unrelated unsaved changes.")
  assert(new TextDecoder().decode(await vscode.workspace.fs.readFile(unconfiguredFile)) === savedTerms, "A rejected addition changed the saved file.")
  await dirtyTerms.save()
  const selectedTerm = ' Widget "selected" \nSecond line '
  const selectionSource = "Before\n" + selectedTerm + "\nAfter"
  const termSelectionSource = await open("selected-preserve-term.txt", "plaintext", selectionSource)
  termSelectionSource.editor.selection = new vscode.Selection(termSelectionSource.document.positionAt(7), termSelectionSource.document.positionAt(7 + selectedTerm.length))
  let additionComplete = false
  const addition = vscode.commands.executeCommand("commentTranslatePlus.addPreserveTerm").then(() => {
    additionComplete = true
  })
  try {
    await waitFor(() => additionComplete, "selected preserve term saved without input confirmation")
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen")
    await addition
  }
  const selectionTerms = parseTermFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(unconfiguredFile)), unconfiguredFile.toString())
  assert(selectionTerms.includes(selectedTerm), "The add command did not save the exact selected text.")
  assert(termSelectionSource.document.getText() === selectionSource && !termSelectionSource.document.isDirty, "Adding selected text modified its source document.")
  checks.push("the add preserve term command saves selected multiline text and whitespace without input confirmation or source edits")
  await config.update("preserveTermsWriteFile", undefined, vscode.ConfigurationTarget.Global)
  checks.push("adding literals reuses the configured JSONC target without changing translation sources or active rules, preserves comments and rejects unsaved edits")
  await vscode.workspace.fs.writeFile(termsFile, new TextEncoder().encode(JSON.stringify(["Widget", "project.lock"])))
  await config.update("preserveTerms", ["./custom-terms.json"], vscode.ConfigurationTarget.Global)
  const termsSource = "Read Feature, API and Widget project.lock. Keep `API` unchanged.\n\nwIdGeT\n\nPROJECT.LOCK\n\nAPI"
  const terms = await open("terms.md", "markdown", termsSource)
  const beforeTerms = (await requests()).length
  await start(terms.document, 4)
  assert((await requests()).slice(beforeTerms).flatMap((request) => request.itemFingerprints ?? []).length === 2, "Custom preserved terms did not replace the default short-name list.")
  const translation = owner.browse.inspect(terms.document.uri)!.units[0].translation
  assert(
    translation.includes("Read Feature") &&
      translation.includes("API") &&
      translation.includes("控件与项目锁") &&
      !translation.includes("Widget") &&
      !translation.includes("project.lock") &&
      translation.includes("`API`"),
    "Custom preserved terms changed model input or prevented translation of mixed prose."
  )
  assert(
    owner.browse
      .inspect(terms.document.uri)!
      .units.slice(1)
      .every((unit) => unit.translation === unit.text),
    "A standalone custom preserved term changed."
  )
  const termUnit = (await owner.documents.parse(terms.document)).groups[0].units[0]
  assert(
    (await requests())
      .slice(beforeTerms)
      .flatMap((request) => request.itemFingerprints ?? [])
      .includes(await requestFingerprint(prepareTranslation(termUnit, 32).text)),
    "Custom preserved terms masked part of a mixed model request."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("preserveTerms", [], vscode.ConfigurationTarget.Global)
  const bypassFile = vscode.Uri.joinPath(workspace, "explicit-terms.json")
  const explicitSource = "Read the complete field."
  await vscode.workspace.fs.writeFile(bypassFile, new TextEncoder().encode(JSON.stringify([explicitSource])))
  await config.update("preserveTerms", [bypassFile.toString()], vscode.ConfigurationTarget.Global)
  const explicit = await open("explicit-terms.md", "markdown", explicitSource)
  await start(explicit.document, 1)
  assert(owner.browse.inspect(explicit.document.uri)!.units[0].translation === explicitSource, "Browse did not preserve the configured full body.")
  const explicitHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", explicit.document.uri, new vscode.Position(0, 2))
  assert(values(explicitHover).includes("阅读完整字段。"), "Hover reused the browse preserved result instead of translating.")
  explicit.editor.selection = new vscode.Selection(0, 0, 0, 0)
  assert(await vscode.commands.executeCommand("commentTranslatePlus.translateAndReplace"), "Cursor replacement failed for a preserved term.")
  assert(explicit.document.getText() === "阅读完整字段。", "Cursor replacement retained a preserved term.")
  const explicitSelection = await open("explicit-selection.md", "markdown", explicitSource)
  explicitSelection.editor.selection = new vscode.Selection(0, 0, 0, explicitSource.length)
  const selectionHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", explicitSelection.document.uri, new vscode.Position(0, 2))
  assert(values(selectionHover).includes("阅读完整字段。"), "Selection hover retained a preserved term.")
  assert(await vscode.commands.executeCommand("commentTranslatePlus.translateAndReplace"), "Selection replacement failed for a preserved term.")
  assert(explicitSelection.document.getText() === "阅读完整字段。", "Selection replacement retained a preserved term.")
  checks.push("source and selection hover/replacement translate preserved terms despite locally completed browse results")
  await config.update("preserveTerms", [], vscode.ConfigurationTarget.Global)
  const clearedTerms = await open("cleared-terms.md", "markdown", "JSON")
  const beforeClearedTerms = (await requests()).length
  await start(clearedTerms.document, 1)
  assert(
    (await requests())
      .slice(beforeClearedTerms)
      .flatMap((request) => request.itemFingerprints ?? [])
      .includes(await requestFingerprint("JSON")),
    "An empty preserveTerms array retained a built-in short name."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const regexFile = vscode.Uri.joinPath(workspace, "regex-terms.jsonc")
  await vscode.workspace.fs.writeFile(
    regexFile,
    new TextEncoder().encode("[\n// Shared regex rule\n" + JSON.stringify({ pattern: "(?:Widget|project\\.lock|https?)", flags: "i" }) + ",\n]")
  )
  await config.update("preserveTerms", [regexFile.toString()], vscode.ConfigurationTarget.Global)
  const regexTerms = await open("regex-terms.md", "markdown", "wIDGET\n\nproject.lock\n\nHtTp\n\nRead HTTP with Widget.")
  const beforeRegexTerms = (await requests()).length
  await start(regexTerms.document, 4)
  const regexItems = (await requests()).slice(beforeRegexTerms).flatMap((request) => request.itemFingerprints ?? [])
  assert(
    JSON.stringify(regexItems) === JSON.stringify([await requestFingerprint("Read HTTP with Widget.")]),
    "Regex terms escaped whole-body matching, changed mixed prose, or failed to complete matching units locally."
  )
  assert(
    owner.browse
      .inspect(regexTerms.document.uri)!
      .units.slice(0, 3)
      .every((unit) => unit.translation === unit.text),
    "Regex terms changed original spelling."
  )
  assert(regexTerms.document.getText() === "wIDGET\n\nproject.lock\n\nHtTp\n\nRead HTTP with Widget." && !regexTerms.document.isDirty, "Regex matching edited source.")
  // Changes remain on the last valid snapshot until scheduled or manual refresh.
  const beforeLocalEdit = (await owner.translations.settings(regexTerms.document.uri)).preserveTerms.identity
  await config.update("preserveTermsRefreshSeconds", 0, vscode.ConfigurationTarget.Global)
  await vscode.workspace.fs.writeFile(regexFile, new TextEncoder().encode("[]"))
  assert((await owner.translations.settings(regexTerms.document.uri)).preserveTerms.identity === beforeLocalEdit, "A local edit bypassed the configured refresh policy.")
  const beforeManualRequests = (await requests()).length
  await control(true)
  try {
    regexTerms.editor.selection = new vscode.Selection(6, 0, 6, 0)
    assert(await owner.browse.retranslateBlock(), "Could not start the pending term refresh probe.")
    await waitFor(async () => (await requests()).length > beforeManualRequests, "pending translation before term refresh")
    const beforeManualRefresh = JSON.stringify(owner.browse.inspect(regexTerms.document.uri))
    await vscode.commands.executeCommand("commentTranslatePlus.refreshPreserveTerms")
    assert(JSON.stringify(owner.browse.inspect(regexTerms.document.uri)) === beforeManualRefresh, "Manual term refresh cleared browse results or cancelled pending translation.")
    assert((await requests()).length === beforeManualRequests + 1, "Manual term refresh submitted existing browse results again.")
  } finally {
    await control(false)
  }
  await waitFor(
    () => owner.browse.inspect(regexTerms.document.uri)?.status === "ready" && owner.browse.inspect(regexTerms.document.uri)?.units.length === 4,
    "pending translation survives term refresh"
  )
  regexTerms.editor.selection = new vscode.Selection(0, 0, 0, 0)
  assert(await owner.browse.retranslateBlock(), "Could not retranslate the former preserved term.")
  const removedFingerprint = await requestFingerprint("wIDGET")
  await waitFor(
    async () =>
      owner.browse.inspect(regexTerms.document.uri)?.status === "ready" &&
      (await requests()).slice(beforeRegexTerms).some((request) => request.itemFingerprints?.includes(removedFingerprint)),
    "new block translation uses the manually refreshed terms"
  )
  const afterRuleRemoval = (await requests()).slice(beforeRegexTerms).flatMap((request) => request.itemFingerprints ?? [])
  assert(afterRuleRemoval.includes(await requestFingerprint("wIDGET")), "Removing a rule reused its previous local-only cache result.")
  const validSettings = await owner.translations.settings(regexTerms.document.uri)
  await vscode.workspace.fs.writeFile(regexFile, new TextEncoder().encode('[{"pattern":"["}]'))
  await vscode.commands.executeCommand("commentTranslatePlus.refreshPreserveTerms")
  assert(
    (await owner.translations.settings(regexTerms.document.uri)).preserveTerms.identity === validSettings.preserveTerms.identity,
    "An invalid saved file replaced the last valid rule set."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await vscode.workspace.fs.writeFile(regexFile, new TextEncoder().encode('["Widget"]'))
  const setTermFile = async (termFile: string | null) => {
    const response = await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ termFile }) })
    assert(response.ok, "Could not configure mock term file.")
  }
  await setTermFile('["RemoteOnly", {"pattern":"HTTP", "flags":"i"}]')
  await config.update("preserveTerms", [regexFile.toString(), origin + "/preserve-terms.json"], vscode.ConfigurationTarget.Global)
  const remoteTerms = await open("remote-terms.md", "markdown", "Widget\n\nRemoteOnly\n\nhTtP\n\nRead Widget.")
  const beforeRemote = (await requests()).length
  await start(remoteTerms.document, 4)
  assert(
    JSON.stringify((await requests()).slice(beforeRemote).flatMap((request) => request.itemFingerprints ?? [])) === JSON.stringify([await requestFingerprint("Read Widget.")]),
    "Local and remote term files were not merged with full-body matching."
  )
  const beforeFailure = (await owner.translations.settings(remoteTerms.document.uri)).preserveTerms.identity
  await setTermFile(null)
  await vscode.workspace.fs.writeFile(regexFile, new TextEncoder().encode("[]"))
  await vscode.commands.executeCommand("commentTranslatePlus.refreshPreserveTerms")
  assert((await owner.translations.settings(remoteTerms.document.uri)).preserveTerms.identity === beforeFailure, "A failed remote refresh discarded the last valid compiled snapshot.")
  // Native configuration changes release the in-memory snapshot; recovery now needs persisted, revalidated data.
  await config.update("preserveTerms", [], vscode.ConfigurationTarget.Global)
  await config.update("preserveTerms", [regexFile.toString(), origin + "/preserve-terms.json"], vscode.ConfigurationTarget.Global)
  assert(
    (await owner.translations.settings(remoteTerms.document.uri)).preserveTerms.identity === beforeFailure,
    "Offline recovery after releasing memory lost the persisted complete snapshot."
  )
  await waitFor(() => owner.browse.inspect(remoteTerms.document.uri)?.status === "ready" && owner.browse.inspect(remoteTerms.document.uri)?.units.length === 4, "offline browse recovery")
  const beforeScheduledRefresh = JSON.stringify(owner.browse.inspect(remoteTerms.document.uri))
  const beforeScheduledRequests = (await requests()).length
  await setTermFile("[]")
  await config.update("preserveTermsRefreshSeconds", 1, vscode.ConfigurationTarget.Global)
  await waitFor(
    async () =>
      (await owner.translations.settings(remoteTerms.document.uri)).preserveTerms.identity !== beforeFailure && owner.browse.inspect(remoteTerms.document.uri)?.status === "ready",
    "scheduled term refresh"
  )
  await config.update("preserveTermsRefreshSeconds", 0, vscode.ConfigurationTarget.Global)
  assert((await owner.translations.settings(remoteTerms.document.uri)).preserveTerms.identity !== beforeFailure, "Changed remote content did not refresh preservation rules.")
  assert(JSON.stringify(owner.browse.inspect(remoteTerms.document.uri)) === beforeScheduledRefresh, "Scheduled term refresh cleared or changed existing browse results.")
  assert((await requests()).length === beforeScheduledRequests, "Scheduled term refresh submitted existing browse results again.")
  remoteTerms.editor.selection = new vscode.Selection(2, 0, 2, 0)
  assert(await owner.browse.retranslateBlock(), "Could not retranslate the former remote term.")
  await waitFor(() => owner.browse.inspect(remoteTerms.document.uri)?.status === "ready", "new block translation uses the scheduled terms")
  assert(
    (await requests())
      .slice(beforeRemote)
      .flatMap((request) => request.itemFingerprints ?? [])
      .includes(await requestFingerprint("RemoteOnly")),
    "Removing remote terms retained local-only results."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await setTermFile(null)
  await config.update("preserveTerms", [origin + "/preserve-terms.json?first-load=failed"], vscode.ConfigurationTarget.Global)
  let initialFailure = false
  try {
    const parsed = await owner.documents.parse(remoteTerms.document)
    await owner.translations.translate(remoteTerms.document, { units: parsed.groups.flatMap((group) => group.units) }, new AbortController().signal)
  } catch {
    initialFailure = true
  }
  assert(initialFailure, "An unavailable first-time term source was silently treated as an empty successful list.")
  const unavailableTerms = await open("unavailable-explicit-terms.md", "markdown", explicitSource)
  const unavailableHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unavailableTerms.document.uri, new vscode.Position(0, 2))
  assert(values(unavailableHover).includes("阅读完整字段。"), "Unavailable term files blocked hover translation.")
  assert(await vscode.commands.executeCommand("commentTranslatePlus.translateAndReplace"), "Unavailable term files blocked replacement.")
  assert(unavailableTerms.document.getText() === "阅读完整字段。", "Unavailable term files prevented translated replacement.")
  checks.push("hover and replacement remain usable when first-time preserve-term loading fails")
  const failedReads = ((await (await fetch(origin + "/state")).json()) as { termFileReads: number }).termFileReads
  for (let index = 0; index < 2; index++) {
    try {
      await owner.translations.settings(remoteTerms.document.uri)
    } catch {
      /* Re-reading settings must preserve the failed snapshot until refresh. */
    }
  }
  assert(
    ((await (await fetch(origin + "/state")).json()) as { termFileReads: number }).termFileReads === failedReads,
    "A failed source was re-fetched outside the configured refresh policy."
  )
  await setTermFile("[]")
  await config.update("preserveTerms", undefined, vscode.ConfigurationTarget.Global)
  await config.update("preserveTermsRefreshSeconds", undefined, vscode.ConfigurationTarget.Global)
  checks.push(
    "local JSON/JSONC and remote term files merge full-body rules; refresh preserves browse results and applies removed rules to new translations, with last valid snapshots retained on failure"
  )

  const folder = vscode.workspace.getWorkspaceFolder(workspace)
  assert(folder, "Missing workspace folder for auto rules.")
  await config.update("auto.exclude", ["**/generated/**", "**/*.skip.ts", "root-only.ts"], vscode.ConfigurationTarget.Global)
  await config.update("auto.enabled", true, vscode.ConfigurationTarget.Global)
  const automatic = await open("automatic.ts", "typescript", "// Read the original document.\nconst autoCode = 1;")
  await waitFor(() => owner.browse.inspect(automatic.document.uri)?.status === "ready" && owner.browse.inspect(automatic.document.uri)?.units.length === 1, "automatic browse")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const beforeDisabled = (await requests()).length
  await vscode.window.showTextDocument(terms.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await vscode.window.showTextDocument(automatic.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert(!owner.browse.inspect(automatic.document.uri) && (await requests()).length === beforeDisabled, "Manual stop was overridden by auto scope.")
  for (const directory of ["generated", "nested/generated", "nested"]) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspace, directory))
  for (const file of ["generated/source.ts", "nested/generated/source.ts", "excluded.skip.ts", "nested/excluded.skip.ts", "root-only.ts"]) {
    const excluded = await open(file, "typescript", "// Read the original document.")
    assert(!automaticScope(excluded.document), "Excluded path remained eligible for automatic translation: " + file)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert(!owner.browse.has(excluded.document.uri), "Glob exclusion did not restrict automatic translation: " + file)
  }
  const nestedAllowed = await open("nested/root-only.ts", "typescript", "// Read the original document.")
  await waitFor(() => owner.browse.inspect(nestedAllowed.document.uri)?.status === "ready", "root-relative exclusion allows nested same-name file")
  const markdownAuto = await open("automatic.md", "markdown", "Read the original document.")
  await waitFor(() => owner.browse.inspect(markdownAuto.document.uri)?.status === "ready", "automatic Markdown without a language allow list")
  await config.update("auto.include", ["**/*.ts", "docs/**"], vscode.ConfigurationTarget.Global)
  await waitFor(() => !owner.browse.has(markdownAuto.document.uri), "narrowed include stops automatic Markdown")
  assert(automaticScope(nestedAllowed.document), "Include failed to match the TypeScript alternative.")
  const overlap = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace, "nested/generated/source.ts"))
  assert(!automaticScope(overlap), "Include overrode an overlapping exclusion.")
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspace, "docs"))
  const included = await open("docs/included.md", "markdown", "Read the original document.")
  await waitFor(() => owner.browse.inspect(included.document.uri)?.status === "ready", "include matches the directory alternative")
  await config.update("auto.include", [], vscode.ConfigurationTarget.Global)
  await waitFor(() => !owner.browse.has(included.document.uri), "empty include stops automatic browse")
  assert(!automaticScope(included.document), "Empty include still allowed automatic translation.")
  await config.update("auto.include", undefined, vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(included.document.uri)?.status === "ready", "default include restores automatic browse")
  await vscode.window.showTextDocument(markdownAuto.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await waitFor(() => owner.browse.inspect(markdownAuto.document.uri)?.status === "ready", "default include permits visible Markdown")
  await config.update("auto.exclude", ["**/automatic.md"], vscode.ConfigurationTarget.Global)
  await waitFor(() => !owner.browse.has(markdownAuto.document.uri), "new exclusion stops automatic browse")
  await config.update("auto.exclude", [], vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(markdownAuto.document.uri)?.status === "ready", "clearing exclusions restarts automatic browse")
  assert(!owner.browse.has(automatic.document.uri), "Exclusion changes overrode a manual stop.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("auto.exclude", ["**/*.md"], vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(markdownAuto.document.uri)?.status === "ready", "manual browse survives auto exclusion")
  await config.update("auto.include", [], vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(markdownAuto.document.uri)?.status === "ready", "manual browse survives empty include")
  await config.update("auto.include", undefined, vscode.ConfigurationTarget.Global)
  const outside = await vscode.workspace.openTextDocument({ language: "markdown", content: "Read the original document." })
  assert(!automaticScope(outside), "Untitled document became eligible for automatic translation.")
  await config.update("auto.enabled", false, vscode.ConfigurationTarget.Global)
  await config.update("auto.exclude", undefined, vscode.ConfigurationTarget.Global)
  await config.update("auto.include", undefined, vscode.ConfigurationTarget.Global)
  checks.push("automatic include matches any rule, excludes win overlaps, empty include disables auto, default restores it and manual browse retains priority")
  checks.push("automatic browse supports code and Markdown, excludes root-relative files and nested directories, reacts to glob changes and respects manual overrides")
  await config.update("activeProfile", "custom", vscode.ConfigurationTarget.Global)
  await config.update("targetLanguage", "zh-CN", vscode.ConfigurationTarget.Global)
  const custom = await open("custom-prompts.md", "markdown", "Read the original document.")
  await start(custom.document, 1)
  assert((await requests()).at(-1)?.customPrompts && (await requests()).at(-1)?.customLanguage, "Custom prompts or language names were overwritten.")
  assert(
    owner.browse.inspect(custom.document.uri)!.units[0].translation.includes("阅读原始文档") && !custom.document.isDirty,
    "Custom template did not translate through the real configuration chain."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("fully custom system/user templates and per-profile language names reach the HTTP adapter without hidden instructions")

  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  const chinese = "这是已经写好的中文说明，不需要再次请求翻译服务。"
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chinese))
  const fingerprint = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
  const chineseRequests = async () => (await requests()).filter((request) => request.inputFingerprint === fingerprint).length
  const sameLanguage = await open("same-language.md", "markdown", chinese)
  const beforeSameLanguage = await chineseRequests()
  await start(sameLanguage.document, 1)
  assert((await chineseRequests()) === beforeSameLanguage, "Target-language browse sent an HTTP request.")
  assert(owner.browse.inspect(sameLanguage.document.uri)!.units[0].translation === chinese, "Target-language browse changed the original.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const sameHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", sameLanguage.document.uri, new vscode.Position(0, 5))
  assert(!values(sameHover).includes("[注释翻译+]") && (await chineseRequests()) === beforeSameLanguage, "Target-language hover requested or duplicated the original.")
  const samePreview = await vscode.workspace.openTextDocument(markdownPreviewUri(sameLanguage.document.uri))
  try {
    await waitFor(() => samePreview.getText() === chinese, "same-language preview")
  } catch (error) {
    throw Error(
      String(error) +
        " · document=" +
        JSON.stringify(samePreview.getText()) +
        " · filesystem=" +
        JSON.stringify(new TextDecoder().decode(await vscode.workspace.fs.readFile(samePreview.uri)))
    )
  }
  assert(
    (await chineseRequests()) === beforeSameLanguage && sameLanguage.document.getText() === chinese && !sameLanguage.document.isDirty,
    "Target-language preview requested translation or modified source."
  )
  await vscode.window.showTextDocument(sameLanguage.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
  await config.update("skipSameLanguage", false, vscode.ConfigurationTarget.Global)
  await start(sameLanguage.document, 1)
  assert((await chineseRequests()) === beforeSameLanguage + 1, "Disabling detection reused a skip result instead of requesting translation.")
  await config.update("skipSameLanguage", true, vscode.ConfigurationTarget.Global)
  await waitFor(() => owner.browse.inspect(sameLanguage.document.uri)?.status === "ready", "restored language detection")
  assert((await chineseRequests()) === beforeSameLanguage + 1, "Restoring language detection discarded its cached result.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("offline target-language detection skips browse, hover and preview HTTP, preserves source and isolates its disable switch in cache")

  const filteredSource = [
    "// 默认展示 图书分类说明",
    "// 借阅时间统计 单位分钟",
    "// 图书借阅状态码",
    "// 图书借阅方式",
    'const endpoint = "https://example.com/a?x=1&y=two";',
    'const uuid = "12345678-1234-5678-9abc-123456789abc";',
    'const identifier = "sampleGroup";',
    'const environment = "SAMPLE_NOTICE_KEY_5XX";',
    'const method = "GET";',
    'const status = "4xx";',
    'const label = "all";',
    'const name = "sample-library";',
    'const message = "Read the original document.";'
  ].join("\n")
  const filtered = await open("filtered-config.ts", "typescript", filteredSource)
  await updateObserved("browse.strings", true)
  const beforeFiltered = (await requests()).length
  await start(filtered.document, 10)
  const sentItems = (await requests()).slice(beforeFiltered).flatMap((request) => request.itemFingerprints ?? [])
  const expectedItems = await Promise.all(["all", "sample-library", "Read the original document."].map(requestFingerprint))
  assert(JSON.stringify(sentItems.sort()) === JSON.stringify(expectedItems.sort()), "Chinese comments or technical string values reached HTTP, or an ambiguous label was discarded.")
  const filteredState = owner.browse.inspect(filtered.document.uri)!
  const filteredComments = filteredState.units.filter((unit) => unit.kind === "comment")
  assert(filteredComments.length === 1 && filteredComments[0].text === filteredSource.split("\n").slice(0, 4).join("\n"), "Consecutive Chinese comments lost paragraph content.")
  assert(
    filteredState.units.filter((unit) => unit.translation !== unit.text).length === 1 && filtered.document.getText() === filteredSource && !filtered.document.isDirty,
    "Request filtering changed technical content, duplicated Chinese prose or edited source."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const afterFiltered = (await requests()).length
  const endpointHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", filtered.document.uri, new vscode.Position(4, 26))
  const chineseHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", filtered.document.uri, new vscode.Position(1, 8))
  assert(
    (await requests()).length === afterFiltered && !values(endpointHover).includes("[注释翻译+]") && !values(chineseHover).includes("[注释翻译+]"),
    "A locally completed or language-skipped hover requested translation or duplicated the source."
  )
  await updateObserved("browse.strings", false)
  checks.push(
    "native TypeScript grammar and default terms skip Chinese, technical values and camelCase/snake_case identifiers while requesting ambiguous labels and preserving cached hover and source"
  )

  const identifierSource = [
    "sourceId",
    "HTTP",
    "HTTPS",
    "HTTP(S)",
    "HTTP/2",
    "TCP/IP",
    "DNS",
    "JSON",
    "json",
    "uv.lock",
    "UTF-8",
    "API",
    "GraphQL",
    "CPU",
    "I/O",
    "source_id",
    "${targetLang}",
    "./src/config.ts",
    "ops@example.com",
    "v1.2.3",
    "0123456789abcdef0123456789abcdef",
    "Read the original document. Keep sourceId and source_id."
  ].join("\n\n")
  const identifiers = await open("identifier-filter.md", "markdown", identifierSource)
  const identifierCount = (await owner.documents.parse(identifiers.document)).groups.flatMap((group) => group.units).length
  const beforeIdentifiers = (await requests()).length
  await start(identifiers.document, identifierCount)
  const identifierItems = (await requests()).slice(beforeIdentifiers).flatMap((request) => request.itemFingerprints ?? [])
  assert(
    JSON.stringify(identifierItems.sort()) ===
      JSON.stringify((await Promise.all(["${targetLang}", "Read the original document. Keep sourceId and source_id."].map(requestFingerprint))).sort()),
    "Standalone Markdown identifiers, paths, addresses, versions or hashes reached HTTP."
  )
  assert(owner.browse.inspect(identifiers.document.uri)!.units.filter((unit) => unit.translation !== unit.text).length === 1, "Identifier filtering hid the natural-language translation.")
  const identifierPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(identifiers.document.uri))
  await waitFor(
    () => identifierPreview.getText() === identifierSource.replace("Read the original document. Keep sourceId and source_id.", "阅读原始文档。 保留 sourceId 和 source_id."),
    "technical identifier preview"
  )
  const afterIdentifiers = (await requests()).length
  const sourceIdFingerprint = await requestFingerprint("sourceId")
  const identifierHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", identifiers.document.uri, new vscode.Position(0, 3))
  assert(
    (await requests()).slice(afterIdentifiers).some((request) => request.itemFingerprints?.includes(sourceIdFingerprint)) && !values(identifierHover).includes("[注释翻译+]"),
    "Identifier hover did not bypass the preserve term or duplicated an unchanged model result."
  )
  assert(identifiers.document.getText() === identifierSource && !identifiers.document.isDirty, "Identifier filtering edited the Markdown source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const identifierYamlSource = "read_only: sourceId\nendpoint: ./src/config.ts\nversion: v1.2.3\n"
  const identifierYaml = await open("identifier-filter.yaml", "yaml", identifierYamlSource)
  const yamlIdentifierCount = (await owner.documents.parse(identifierYaml.document)).groups.flatMap((group) => group.units).length
  const beforeIdentifierYaml = (await requests()).length
  await start(identifierYaml.document, yamlIdentifierCount)
  const yamlIdentifierItems = (await requests()).slice(beforeIdentifierYaml).flatMap((request) => request.itemFingerprints ?? [])
  const expectedYamlIdentifierItems = await Promise.all(["endpoint", "version"].map(requestFingerprint))
  assert(JSON.stringify(yamlIdentifierItems.sort()) === JSON.stringify(expectedYamlIdentifierItems.sort()), "YAML keys stopped translating or technical values reached HTTP.")
  assert(identifierYaml.document.getText() === identifierYamlSource && !identifierYaml.document.isDirty, "Identifier filtering edited YAML source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push(
    "default terms preserve whole Markdown/YAML identifiers while technical values complete locally and prose and unmatched YAML keys translate; preview preserves terms, hover requests them and unchanged results do not duplicate source"
  )

  const mixed = await open("mixed-languages.ts", "typescript", "// " + chinese + '\nconst message = "' + chinese + '";\n// Read the original document.\nconst untouched = 1;')
  await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
  await waitFor(
    () =>
      vscode.workspace.textDocuments
        .filter((document) => document.uri.scheme === "comment-translate-plus-preview")
        .every((document) => !document.getText().includes("正在翻译") && !document.getText().includes(previewLoadingMarker)),
    "preview refreshes before mixed-code request count"
  )
  const beforeMixed = (await requests()).length
  await start(mixed.document, 3)
  assert((await requests()).length === beforeMixed + 1 && (await requests()).at(-1)?.count === 1, "Mixed code sent target-language comments or strings to the model.")
  assert(
    owner.browse.inspect(mixed.document.uri)!.units.filter((unit) => unit.translation !== unit.text).length === 1,
    "Mixed code failed to preserve skipped units or translate its foreign comment."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  checks.push("mixed code batches skip Chinese comments and string literals while sending only the foreign-language unit")

  await config.update("sourceLanguage", "", vscode.ConfigurationTarget.Global)
  const automaticSource = await open("automatic-source.md", "markdown", "Read the original document. Leave source language unspecified.")
  await start(automaticSource.document, 1)
  assert(
    (await requests()).at(-1)?.sourceDeclared === false && (await requests()).at(-1)?.target === "zh-CN",
    "Empty source did not omit its declaration while retaining a concrete target."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("sourceLanguage", "en", vscode.ConfigurationTarget.Global)
  checks.push("empty source language uses automatic detection without a source prompt declaration and keeps an explicit resolved target")

  await vscode.commands.executeCommand("commentTranslatePlus.showErrors")
  let output: vscode.TextDocument | undefined
  await waitFor(() => {
    output = vscode.workspace.textDocuments.find((document) => owner.documents.isOwnOutput(document))
    return !!output
  }, "extension output document")
  const beforeFailureLog = output!.getText().length
  const faultSource = "1. 这是已经写好的中文说明，不需要再次请求翻译服务。\n2. Read [code-only-no-request](./examples/development/code-only.md).\n3. Read the original document."
  const fault = await open("failed-link.md", "markdown", faultSource)
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ damageLink: true }) })
  try {
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => owner.browse.inspect(fault.document.uri)?.status === "error", "specific partial link failure")
    const snapshot = owner.browse.inspect(fault.document.uri)!
    assert(snapshot.total === 3 && snapshot.units.length === 2 && snapshot.failedUnits.length === 1, "Partial failure hid completed work or miscounted unresolved units.")
    await waitFor(() => output!.getText().slice(beforeFailureLog).includes("failed-link.md:2:1"), "human-readable failure details for the current document")
    const failureLog = output!.getText().slice(beforeFailureLog)
    const errorEntries = failureLog.split(/\r?\n/).filter((line) => /^\[[^\n]+\] \[ERROR\]/.test(line) && line.includes("failed-link.md"))
    assert(errorEntries.length === 1, "One failed task produced repeated error reports: " + JSON.stringify({ errorEntries, failureLog: failureLog.slice(-3000) }))
    assert(
      failureLog.includes("2/3") &&
        failureLog.includes("failed-link.md:2:1") &&
        failureLog.includes("code-only.md") &&
        failureLog.includes("期望：./examples/development/code-only.md") &&
        failureLog.includes("对应标记缺失或被改写"),
      "Failure report lost its partial count, original position or specific missing target."
    )
    assert(!failureLog.includes("system=") && !failureLog.includes("--- 原文与译文 ---"), "Default summary expanded full request contents.")
    const beforeShow = output!.getText()
    await vscode.commands.executeCommand("commentTranslatePlus.showErrors")
    await vscode.commands.executeCommand("commentTranslatePlus.showErrors")
    assert(output!.getText() === beforeShow, "Opening diagnostics printed the same failures again.")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ damageLink: false }) })
  }
  const beforeRepair = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.retry")
  await waitFor(() => owner.browse.inspect(fault.document.uri)?.status === "ready" && owner.browse.inspect(fault.document.uri)?.units.length === 3, "repair only the failed link")
  assert((await requests()).length === beforeRepair + 1 && (await requests()).at(-1)?.count === 1, "Retry requested completed neighbours.")
  assert(fault.document.getText() === faultSource && !fault.document.isDirty, "Failure reporting modified the source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("partial failure logs once with the exact source line and missing link delimiter; diagnostics stays quiet and retry requests only the unresolved unit")

  for (const mode of ["once", "always"]) {
    const contaminationSource =
      "- Read the original document. Reference contamination case. " +
      mode +
      ". Follow [Guide](./guide.md). Keep `sourceId_abcdefghijklmnopqrstuvwxyz_123456789`.\n- 这是已有的中文说明，调用 `sample_task`。"
    const contamination = await open("reference-contamination-" + mode + ".md", "markdown", contaminationSource)
    const target = (await owner.documents.parse(contamination.document)).groups.flatMap((group) => group.units)[0]
    const fingerprint = await requestFingerprint(prepareTranslation(target, 32).text)
    const before = (await requests()).length
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceContamination: mode }) })
    try {
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      await waitFor(() => owner.browse.inspect(contamination.document.uri)?.status === (mode === "once" ? "ready" : "error"), "reference contamination recovery " + mode)
      const snapshot = owner.browse.inspect(contamination.document.uri)!
      const sent = (await requests()).slice(before).filter((request) => request.itemFingerprints?.includes(fingerprint))
      assert(
        sent.length === (mode === "once" ? 2 : 3) && sent.every((request) => request.count === 1),
        "Reference contamination retried the local neighbour or bypassed the attempt limit."
      )
      assert(
        sent[0].referenceIncluded && !sent[0].retryFeedbackIncluded && sent.slice(1).every((request) => request.retryFeedbackIncluded && request.retryFeedbackEnglishSeparated),
        "Reference recovery omitted the context or independent retry instructions."
      )
      assert(
        snapshot.units.length === (mode === "once" ? 2 : 1) && snapshot.failedUnits.length === (mode === "once" ? 0 : 1),
        "Contamination was accepted or the completed neighbour was discarded."
      )
      assert(
        snapshot.units.every((unit) => unit.start !== target.start || !unit.translation.includes("sample_task")),
        "Reference code appeared in the target's translation."
      )
      await waitFor(
        () =>
          output!
            .getText()
            .split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m)
            .some((entry) => entry.includes("] reference-contamination-" + mode + ".md · ") && entry.includes("内部换行")),
        "context continuation is rejected with an internal-line-break diagnostic"
      )
      assert(contamination.document.getText() === contaminationSource && !contamination.document.isDirty, "Contamination handling changed the source.")
    } finally {
      await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceContamination: false }) })
    }
    if (mode === "always") {
      const beforeRepair = (await requests()).length
      await vscode.commands.executeCommand("commentTranslatePlus.retry")
      await waitFor(() => owner.browse.inspect(contamination.document.uri)?.status === "ready", "manual reference contamination recovery")
      const repairs = (await requests()).slice(beforeRepair).filter((request) => request.itemFingerprints?.includes(fingerprint))
      assert(repairs.length === 1 && repairs[0].count === 1, "Contamination entered the cache or manual recovery retried a completed neighbour.")
    }
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const beforeReuse = (await requests()).length
    await start(contamination.document, 2)
    assert((await requests()).length === beforeReuse, "The validated source-only recovery was not reused from cache.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    checks.push("reference contamination " + mode + " reports added code, preserves source and neighbours, and caches only validated recovery")
  }

  const leakSource = "Read the original document. DiagnoseRetryLeak."
  const leakDocument = await open("retry-diagnostic-leak.md", "markdown", leakSource)
  const beforeLeak = (await requests()).length
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leakDiagnostics: true }) })
  try {
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => owner.browse.inspect(leakDocument.document.uri)?.status === "error", "translated retry diagnostics are rejected")
    const snapshot = owner.browse.inspect(leakDocument.document.uri)!
    assert(snapshot.units.length === 0 && snapshot.failedUnits.length === 1, "Translated diagnostics appeared as a completed browse result.")
    const fingerprint = await requestFingerprint(leakSource)
    const leakRequests = (await requests()).slice(beforeLeak).filter((request) => request.inputFingerprint === fingerprint)
    assert(leakRequests.length === 3 && leakRequests.every((request) => request.count === 1), "Diagnostic leakage bypassed the attempt limit or changed the target.")
    await waitFor(() => output!.getText().includes("translation-feedback-leaked"), "diagnostic leakage reports its concrete failure")
    assert(leakDocument.document.getText() === leakSource && !leakDocument.document.isDirty, "Diagnostic leakage changed source text.")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leakDiagnostics: false }) })
  }
  const beforeLeakRepair = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.retry")
  await waitFor(() => owner.browse.inspect(leakDocument.document.uri)?.status === "ready", "retry after diagnostic leakage")
  assert(
    (await requests()).length === beforeLeakRepair + 1 && owner.browse.inspect(leakDocument.document.uri)!.units[0].translation.includes("阅读原始文档"),
    "An invalid diagnostic was cached instead of repaired."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("translated retry diagnostics never enter browse results or cache; exhaustion preserves source and manual retry repairs only the failed target")

  await updateObserved("logDetails", true)
  const detailed = await open("detailed-log.md", "markdown", "Read the original document. Inspect this request in detail.")
  const currentDetails = () =>
    output!
      .getText()
      .split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m)
      .filter((entry) => entry.includes("] detailed-log.md · "))
      .join("")
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: true }) })
  try {
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await waitFor(() => owner.browse.inspect(detailed.document.uri)?.status === "error", "detailed retry exhaustion")
    await waitFor(() => currentDetails().includes("detailed-log.md · 翻译失败"), "exhausted task reaches the native output document before manual recovery")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: false }) })
  }
  await vscode.commands.executeCommand("commentTranslatePlus.retry")
  await waitFor(() => owner.browse.inspect(detailed.document.uri)?.status === "ready" && owner.browse.inspect(detailed.document.uri)?.units.length === 1, "detailed retry recovery")
  try {
    await waitFor(() => {
      const text = currentDetails()
      return text.includes("detailed-log.md · 任务完成") && (text.match(/system=S\d+/g) ?? []).length === 4
    }, "all four on-demand request details in the asynchronous output document")
  } catch (error) {
    throw Error(String(error) + "\n" + currentDetails() + "\n--- recent output ---\n" + output!.getText().slice(-12000))
  }
  const detailLog = currentDetails()
  const references = [...detailLog.matchAll(/system=(S\d+)/g)].map((match) => match[1])
  assert(
    references.length === 4 && new Set(references).size === 1 && (detailLog.match(/--- system S\d+ ---/g) ?? []).length === 1,
    "Identical actual system prompts repeated across retries/tasks or lost their definition: " + JSON.stringify({ references, detailLog })
  )
  assert(
    (detailLog.match(/--- user ---/g) ?? []).length === 6 &&
      (detailLog.match(/--- assistant ---/g) ?? []).length === 2 &&
      (detailLog.match(/- Problem:/g) ?? []).length === 2 &&
      !detailLog.includes("Current request: 1 item(s).") &&
      (detailLog.match(/--- assistant（finish_reason=stop） ---/g) ?? []).length === 4,
    "The four model responses or two independent retry diagnostics were hidden."
  )
  assert(detailLog.includes("阅读原始文档") && !detailLog.includes("--- 原文与译文 ---"), "Enabled details omitted the model response or repeated source/translation pairs.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  const cancelledSource = "Read the original document. Inspect cancellation details."
  const cancelledDetail = await open("cancelled-detail.md", "markdown", cancelledSource)
  const cancelledStart = output!.getText().length
  const cancelledRequest = (await requests()).length
  await control(true)
  try {
    const pending = vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", cancelledDetail.document.uri, new vscode.Position(0, 6))
    await waitFor(async () => (await requests()).length === cancelledRequest + 1, "detailed hover starts HTTP")
    await vscode.commands.executeCommand("commentTranslatePlus.cancel")
    await waitFor(async () => (await requests())[cancelledRequest]?.cancelled === true, "detailed hover aborts HTTP")
    assert(!values(await pending).includes("[注释翻译+]"), "Cancelled detail hover returned a stale translation.")
    await waitFor(() => output!.getText().slice(cancelledStart).includes("cancelled-detail.md · 任务已取消"), "cancelled request reaches the native output document")
    const cancelledLog = output!.getText().slice(cancelledStart)
    assert(!cancelledLog.includes("--- 原文与译文 ---"), "Cancelled native hover printed a source/translation section.")
    assert(cancelledLog.includes("用户取消") && cancelledLog.includes("HTTP 已开始"), "Native cancellation lost its origin or HTTP stage.")
    assert(cancelledDetail.document.getText() === cancelledSource && !cancelledDetail.document.isDirty, "Cancellation diagnostics modified the source.")
  } finally {
    await control(false)
  }
  checks.push("cancelled native hover retains cancellation origin and HTTP stage without source/translation pairs or stale translation")
  await config.update("logDetails", false, vscode.ConfigurationTarget.Global)
  checks.push("opt-in request details define repeated system prompts once across retries/tasks, preserve user inputs and pair sources with restored results")

  const outputEditor = await vscode.window.showTextDocument(output!, { viewColumn: vscode.ViewColumn.One, preview: false })
  const line = output!
    .getText()
    .split(/\r?\n/)
    .findIndex((text) => /^[A-Za-z].*\p{L}/u.test(text))
  assert(line >= 0, "No English log line available for the self-translation regression.")
  outputEditor.selection = new vscode.Selection(line, 0, line, output!.lineAt(line).text.length)
  const beforeOutputHover = (await requests()).length
  const outputHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", output!.uri, new vscode.Position(line, 5))
  assert(
    !values(outputHover).includes("[注释翻译+]") && (await requests()).length === beforeOutputHover && !owner.browse.inspect(output!.uri),
    "Browse the extension's own logs triggered translation."
  )
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
  checks.push("selection and documentation hover never translate the extension's own output document")

  await updateObserved("activeProfile", "unchanged")
  const unchangedHoverSource = "Read the original document.\r\nContinue reading.\r\n\r\nKeep `sourceId` unchanged."
  const unchangedHover = await open("unchanged-hover.md", "markdown", unchangedHoverSource)
  const unchangedHoverAt = new vscode.Position(0, 5)
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = (await requests()).length
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unchangedHover.document.uri, unchangedHoverAt)
    assert(!values(hover).includes("[注释翻译+]"), "Whitespace-only output appeared in independent hover.")
    assert(!attempt || (await requests()).length === before, "Repeated unchanged hover escaped the cache.")
  }
  unchangedHover.editor.selection = new vscode.Selection(unchangedHover.document.positionAt(0), unchangedHover.document.positionAt(unchangedHoverSource.length))
  const unchangedSelection = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unchangedHover.document.uri, unchangedHoverAt)
  assert(!values(unchangedSelection).includes("[注释翻译+]"), "Whitespace-only selected output exposed a translation or replacement action.")
  assert(!owner.browse.inspect(unchangedHover.document.uri), "Independent unchanged hover enabled browse mode.")
  assert(unchangedHover.document.getText() === unchangedHoverSource && !unchangedHover.document.isDirty, "Unchanged hover modified source.")
  checks.push("independent and selected hover suppress whitespace-only translations and replacement actions while reusing successful results")

  const unchangedDocumentation = await open("unchanged-documentation.txt", "plaintext", "documentation target")
  let unchangedDocumentationText = "Read the original document.\n\nKeep `sourceId` unchanged."
  const unchangedDocumentationProvider = vscode.languages.registerHoverProvider(
    { language: "plaintext", pattern: "**/unchanged-documentation.txt" },
    { provideHover: () => new vscode.Hover(new vscode.MarkdownString(unchangedDocumentationText)) }
  )
  const unchangedDiagnostics = vscode.languages.createDiagnosticCollection("unchanged-hover")
  const unchangedDiagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 13), "Read the original document.")
  unchangedDiagnostic.source = "whitespace-diagnostic"
  unchangedDiagnostics.set(unchangedDocumentation.document.uri, [unchangedDiagnostic])
  await config.update("hover.documentation", true, vscode.ConfigurationTarget.Global)
  try {
    const before = (await requests()).length
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unchangedDocumentation.document.uri, new vscode.Position(0, 5))
    assert(hovers.length === 1 && values(hovers) === unchangedDocumentationText, "Whitespace-only documentation or diagnostics added a duplicate hover.")
    const after = (await requests()).length
    assert(after > before, "Documentation unchanged regression did not exercise the translation service.")
    await vscode.commands.executeCommand("vscode.executeHoverProvider", unchangedDocumentation.document.uri, new vscode.Position(0, 5))
    assert((await requests()).length === after, "Unchanged documentation or diagnostic results escaped the cache.")
    unchangedDocumentationText = '---\nlabel: "Read the original document."\n---'
    const stringHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unchangedDocumentation.document.uri, new vscode.Position(0, 5))
    assert(stringHovers.length === 2 && values(stringHovers).includes("originaldocument"), "Documentation hover hid a meaningful decoded-string whitespace change.")
  } finally {
    unchangedDiagnostics.dispose()
    unchangedDocumentationProvider.dispose()
    await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  }
  checks.push("language-service documentation and diagnostic hover retain original content without whitespace-only duplicates and reuse cache")

  const stringSelectionSource = '---\nlabel: "Read the original document."\n---'
  const stringSelection = await open("whitespace-string-selection.md", "markdown", stringSelectionSource)
  stringSelection.editor.selection = new vscode.Selection(stringSelection.document.positionAt(0), stringSelection.document.positionAt(stringSelectionSource.length))
  const stringSelectionHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", stringSelection.document.uri, new vscode.Position(1, 10))
  assert(values(stringSelectionHover).includes("[注释翻译+]") && values(stringSelectionHover).includes("originaldocument"), "Selected hover hid meaningful decoded-string whitespace.")
  checks.push("documentation and selected hover preserve meaningful string whitespace changes after per-unit comparison")

  const unchangedSource = '---\nlabel: "AcmeSDK"\n---\n\nRead the original document.\n\nKeep `sourceId` unchanged.'
  const unchanged = await open("unchanged.md", "markdown", unchangedSource)
  await start(unchanged.document, 4)
  const completed = owner.browse.inspect(unchanged.document.uri)!
  assert(
    completed.units.every((unit) => unit.translation === unit.text) && !completed.loading.length && !completed.errors.length && !completed.failedUnits.length,
    "Unchanged model results were lost, left pending or marked as errors. " + JSON.stringify(completed)
  )
  const unchangedRequests = (await requests()).length
  const unchangedLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", unchanged.document.uri, 1000)
  assert(!unchangedLenses.some((lens) => lens.command?.title === " "), "Unchanged results created empty translation rows.")
  for (const line of [1, 4, 6]) {
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", unchanged.document.uri, new vscode.Position(line, 5))
    assert(!values(hover).includes("[注释翻译+]"), "Unchanged model output appeared as a duplicate hover.")
  }
  const unchangedPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(unchanged.document.uri))
  try {
    await waitFor(() => unchangedPreview.getText() === unchangedSource, "unchanged preview keeps original YAML representation")
  } catch (error) {
    throw Error(
      String(error) +
        " · document=" +
        JSON.stringify(unchangedPreview.getText()) +
        " · filesystem=" +
        JSON.stringify(new TextDecoder().decode(await vscode.workspace.fs.readFile(unchangedPreview.uri)))
    )
  }
  await vscode.commands.executeCommand("commentTranslatePlus.retry")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await start(unchanged.document, 4)
  assert((await requests()).length === unchangedRequests, "Retry, preview or stop/start re-requested successful unchanged results.")
  assert(unchanged.document.getText() === unchangedSource && !unchanged.document.isDirty, "Unchanged translation handling modified source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  checks.push("unchanged and representation-only responses complete normally, create no rows or duplicate hovers, preserve preview/source and stay cached across controls")

  await waitFor(
    () =>
      vscode.workspace.textDocuments.filter((document) => document.uri.scheme === "comment-translate-plus-preview").every((document) => !document.getText().includes('role="progressbar"')),
    "previous previews complete before loading lifecycle probe"
  )
  const pendingSource = "# Preview lifecycle probe\n\nRead the original document. Keep this fresh context."
  const pendingDocument = await open("pending-preview.md", "markdown", pendingSource)
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold: true }) })
  let pendingPreview: vscode.TextDocument
  try {
    pendingPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(pendingDocument.document.uri))
    await waitFor(() => pendingPreview.getText().includes('role="progressbar"'), "inline preview loading markers")
    assert(!pendingPreview.getText().includes("> 正在翻译"), "Preview contains a top loading banner.")
    await vscode.commands.executeCommand("commentTranslatePlus.cancel")
    await waitFor(() => !pendingPreview.getText().includes('role="progressbar"') && pendingPreview.getText().includes("翻译已取消"), "cancel removes preview markers")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold: false }) })
  }
  await vscode.commands.executeCommand("commentTranslatePlus.preview")
  await waitFor(() => pendingPreview.getText().includes("阅读原始文档") && !pendingPreview.getText().includes('role="progressbar"'), "reopening cancelled preview completes")
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: true }) })
  try {
    assert(
      await pendingDocument.editor.edit((builder) => builder.insert(pendingDocument.document.positionAt(pendingSource.length), " New paragraph context.")),
      "Preview error probe edit failed."
    )
    await waitFor(() => pendingPreview.getText().includes("翻译失败") && !pendingPreview.getText().includes('role="progressbar"'), "failed preview clears markers and remains readable")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: false }) })
  }
  checks.push("preview loading uses inline markers and clears them on cancellation, reopening, completion and protocol failure")

  const replacementSource = "const before = 1;\n// Read the original document. (keep ) %20 %2520 %3A %E4%B8%AD\nconst after = 2;"
  const replacement = await open("hover replacement (中文 %25).ts", "typescript", replacementSource)
  const replacementAt = new vscode.Position(1, 10)
  const replacementAction = async (document = replacement.document, position = replacementAt) => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, position)
    const header = hovers.flatMap((hover) => hover.contents).find((item) => typeof item !== "string" && item.value.includes("command:commentTranslatePlus.replaceHover")) as
      | vscode.MarkdownString
      | undefined
    assert(header && typeof header.isTrusted === "object" && header.isTrusted.enabledCommands.length === 1, "Source hover did not expose one narrowly trusted replace command.")
    assert((header.value.match(/command:/g) ?? []).length === 1, "Source hover contains unrelated actions.")
    const query = header.value.match(/command:commentTranslatePlus\.replaceHover\?([^ )"]+)/)?.[1]
    assert(query, "Replacement action is missing its snapshot arguments.")
    const command = vscode.Uri.parse("command:commentTranslatePlus.replaceHover?" + query)
    let args: unknown
    // Use the same URI/JSON boundary as native command links, including VS Code's fallback for literal percent text.
    try {
      args = JSON.parse(decodeURIComponent(command.query))
    } catch {
      args = JSON.parse(command.query)
    }
    return (args as { uri: string; version: number; text: string }[])[0]
  }
  const action = await replacementAction()
  const beforeReplace = (await requests()).length
  assert(await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", action), "Hover replace failed.")
  assert(replacement.document.getText() === replacementSource.replace("Read the original document.", "阅读原始文档。"), "Hover replace changed unrelated code or comment syntax.")
  assert((await requests()).length === beforeReplace, "Clicking replace requested translation again.")
  await vscode.commands.executeCommand("undo")
  await waitFor(() => replacement.document.getText() === replacementSource, "native undo for hover replacement")
  assert(
    (await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", action)) === false && replacement.document.getText() === replacementSource,
    "A stale hover wrote into a newer document version."
  )
  const freshAction = await replacementAction()
  assert(
    (await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", { ...freshAction, start: 0, end: 0, source: "" })) === false &&
      replacement.document.getText() === replacementSource,
    "Replacement accepted an empty source range as an insertion."
  )
  await config.update("targetLanguage", "fr", vscode.ConfigurationTarget.Global)
  assert(
    (await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", freshAction)) === false && replacement.document.getText() === replacementSource,
    "A stale configuration snapshot replaced source."
  )
  await config.update("targetLanguage", "zh-CN", vscode.ConfigurationTarget.Global)
  const readonlyUri = vscode.Uri.parse("hover-readonly:/readonly.ts")
  const readonlyProvider = vscode.workspace.registerTextDocumentContentProvider("hover-readonly", { provideTextDocumentContent: () => replacementSource })
  try {
    const readonlyDocument = await vscode.workspace.openTextDocument(readonlyUri)
    await vscode.window.showTextDocument(readonlyDocument, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    const readonlyHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", readonlyUri, replacementAt)
    assert(
      values(readonlyHover).includes("阅读原始文档") && !values(readonlyHover).includes("command:commentTranslatePlus.replaceHover"),
      "Readonly hover exposed an unusable replace action."
    )
    assert(
      (await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", { ...freshAction, uri: readonlyUri.toString(), version: readonlyDocument.version })) === false,
      "Readonly document accepted replacement."
    )
    assert(readonlyDocument.getText() === replacementSource && !readonlyDocument.isDirty, "Readonly replacement modified the document.")
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
  } finally {
    readonlyProvider.dispose()
  }
  checks.push("hover replacement preserves surrounding code, uses no extra request, supports undo and rejects stale or readonly targets")

  const promptSource = "You are a professional ${targetLang} translator. Translate each source item accurately and fluently."
  const promptTranslation = "您是专业的${targetLang}翻译员。请准确流畅地翻译每个源项。"
  for (const newline of ["\n", "\r\n"]) {
    const source = ["const before = 1;", 'const prompt = "' + promptSource + '";', "const after = 2;"].join(newline)
    const target = await open("hover-prompt-" + (newline === "\n" ? "lf" : "crlf") + ".ts", "typescript", source)
    assert(target.document.getText() === source, "Prompt fixture lost its original line endings.")
    const neighbor = await vscode.workspace.openTextDocument({ content: "Unrelated editor must stay unchanged.", language: "plaintext" })
    await vscode.window.showTextDocument(neighbor, { viewColumn: vscode.ViewColumn.Two, preserveFocus: false, preview: false })
    await waitFor(() => vscode.window.activeTextEditor?.document === neighbor, "neighbor editor focus")
    assert(
      vscode.window.visibleTextEditors.some((editor) => editor.document === target.document),
      "Hover target is not visible."
    )
    const promptAction = await replacementAction(target.document, new vscode.Position(1, 25))
    const beforePromptReplace = (await requests()).length
    assert(await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", promptAction), "Visible inactive prompt replacement failed for " + JSON.stringify(newline))
    assert(target.document.getText() === source.replace(promptSource, promptTranslation), "Prompt replacement changed placeholders, surrounding code or line endings.")
    assert(neighbor.getText() === "Unrelated editor must stay unchanged.", "Replacement modified the focused neighbor editor.")
    assert((await requests()).length === beforePromptReplace, "Prompt replacement requested translation again.")
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
  }
  checks.push("hover replaces visible inactive source with literal prompt placeholders under LF and CRLF without changing another editor or requesting again")

  const hidden = await open("hover-hidden.md", "markdown", "Read the original document.")
  const hiddenAction = await replacementAction(hidden.document, new vscode.Position(0, 10))
  const neighbor = await open("hover-neighbor.md", "markdown", "Unrelated editor must stay unchanged.")
  await waitFor(() => !vscode.window.visibleTextEditors.some((editor) => editor.document === hidden.document), "hidden replacement target")
  assert((await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", hiddenAction)) === false, "An invisible source accepted a hover replacement.")
  assert(hidden.document.getText() === "Read the original document." && neighbor.document.getText() === "Unrelated editor must stay unchanged.", "Hidden replacement changed a document.")
  const hiddenTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === hiddenAction.uri)
  assert(hiddenTabs.length > 0 && (await vscode.window.tabGroups.close(hiddenTabs)), "The source tab could not be closed.")
  await waitFor(
    () => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === hiddenAction.uri)),
    "closed replacement tab"
  )
  assert((await vscode.commands.executeCommand("commentTranslatePlus.replaceHover", hiddenAction)) === false, "A closed source accepted a hover replacement.")
  checks.push("hover replacement keeps encoded URI and percent content intact while hidden and closed sources remain rejected")

  await config.update("hover.comments", false, vscode.ConfigurationTarget.Global)
  await config.update("hover.documentation", true, vscode.ConfigurationTarget.Global)
  const richDocumentation = new vscode.MarkdownString("**Read the original document.**\n\n- Keep `sourceId` unchanged.")
  const richProvider = vscode.languages.registerHoverProvider("typescript", { provideHover: () => new vscode.Hover(richDocumentation) })
  try {
    await vscode.window.showTextDocument(replacement.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", replacement.document.uri, new vscode.Position(0, 8))
    const translated = hovers.flatMap((hover) => hover.contents).find((content) => typeof content !== "string" && content.value.startsWith("**阅读原始文档。**")) as
      | vscode.MarkdownString
      | undefined
    assert(
      translated && !translated.isTrusted && !translated.value.includes("command:commentTranslatePlus.replaceHover"),
      "Translated documentation lost native Markdown formatting or gained a source edit action."
    )
    assert(richDocumentation.value.startsWith("**Read the original document.**"), "Translation mutated the original language-service documentation.")
    const diagnostics = vscode.languages.createDiagnosticCollection("hover-probe")
    try {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 6, 0, 12), "Read the original document.", vscode.DiagnosticSeverity.Warning)
      diagnostic.source = "probe"
      diagnostic.code = 0
      diagnostics.set(replacement.document.uri, [diagnostic])
      const errors = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", replacement.document.uri, new vscode.Position(0, 8))
      assert(
        values(errors).replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("&nbsp;", " ").includes("阅读原始文档。 probe(0)"),
        "Diagnostic hover did not translate the message or preserve source/code zero: " + JSON.stringify(values(errors))
      )
      assert(diagnostic.message === "Read the original document.", "Translation mutated the original diagnostic.")
    } finally {
      diagnostics.dispose()
    }
  } finally {
    richProvider.dispose()
    await config.update("hover.comments", true, vscode.ConfigurationTarget.Global)
    await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  }
  checks.push("language-service and diagnostic hover render translated Markdown, preserve original content and source/code without replacement controls")
  const protectedSource = "`pages` is required when `edition` is set. Literal {1} and <CTP0>.\n\n**C — Books / Journals.** Confirm scope across **Reading categories**."
  const protectedDocument = await open("protected-content.md", "markdown", protectedSource)
  await start(protectedDocument.document, 2)
  const protectedUnits = owner.browse.inspect(protectedDocument.document.uri)!.units
  assert(protectedUnits[0].translation.startsWith("当设置 `edition` 时，必须提供 `pages`。"), "Browse rejected reordered code or restored the wrong code identifier.")
  assert(protectedUnits[0].translation.includes("{1}") && protectedUnits[0].translation.includes("<CTP0>"), "Literal source markers were consumed as generated placeholders.")
  assert(protectedUnits[1].translation.startsWith("**C — 图书/期刊。** 确认范围"), "Browse lost the safe paired formatting boundary around Chinese punctuation.")
  const protectedRequests = (await requests()).length
  const protectedHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", protectedDocument.document.uri, new vscode.Position(0, 10))
  assert(values(protectedHover).includes("当设置 `edition` 时，必须提供 `pages`。"), "Hover did not reuse the restored protected result.")
  const protectedPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(protectedDocument.document.uri))
  await waitFor(
    () => protectedPreview.getText().includes("当设置 `edition` 时，必须提供 `pages`。") && protectedPreview.getText().includes("**C — 图书/期刊。** 确认范围"),
    "protected content preview"
  )
  assert(
    (await requests()).length === protectedRequests && protectedDocument.document.getText() === protectedSource && !protectedDocument.document.isDirty,
    "Protection broke shared cache or changed source."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push(
    "short placeholders restore reordered code, literal marker text and paired formatting with added inner spaces/tabs across browse, hover and native preview without re-requesting or changing source"
  )
  const beforeScalarTerms = config.inspect<readonly string[]>("preserveTerms")?.globalValue
  await config.update("preserveTerms", [], vscode.ConfigurationTarget.Global)
  try {
    const scalarSource = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, "examples/development/scalars-and-table.md")))
    const scalarDocument = await open("scalar-display.md", "markdown", scalarSource)
    await start(scalarDocument.document, 10)
    const scalarUnits = owner.browse.inspect(scalarDocument.document.uri)!.units.filter((unit) => unit.format === "yaml")
    assert(
      scalarUnits.length === 2 &&
        scalarUnits.some((unit) => unit.content === "default_enabled") &&
        owner.browse.inspect(scalarDocument.document.uri)!.units.some((unit) => unit.text.trim() === "Read the complete field."),
      "YAML keys and complete values were not independent units."
    )
    assert(!scalarUnits.some((unit) => unit.text === "true" || unit.protected?.length), "YAML native data still used model placeholders.")
    const scalarLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", scalarDocument.document.uri, 1000)
    assert(scalarLenses.filter((lens) => lens.command?.title === " ").length === 6, "Split fields or table cells did not share their logical display row.")
    const scalarRequests = (await requests()).length
    const scalarPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(scalarDocument.document.uri))
    await waitFor(() => scalarPreview.getText().includes('"默认启用": true') && scalarPreview.getText().includes("| 阅读原始文档。 | 保留 text. |"), "scalar/table preview assembly")
    assert(
      (await requests()).length === scalarRequests && scalarDocument.document.getText() === scalarSource && !scalarDocument.document.isDirty,
      "Scalar/table display changed source or discarded shared cache."
    )
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    checks.push("YAML keys and scalar values translate independently, native values stay local, fields/tables share rows and previews preserve original pipes using shared cache")

    const yamlFieldsSource = "name: data-analysis\nmetadata:\n  availability: active\n  default_enabled: true\n  read_only: false\n  required: false"
    const yamlFieldsDocument = await open("yaml-fields.yaml", "yaml", yamlFieldsSource)
    await start(yamlFieldsDocument.document, 8)
    const yamlFields = owner.browse.inspect(yamlFieldsDocument.document.uri)!.units
    const yamlRows = displayTranslations(yamlFieldsSource, yamlFields)
    assert(
      JSON.stringify(yamlRows.map((row) => translationDisplayText(row.translation, "yaml").trimEnd())) ===
        JSON.stringify(["名称: 数据分析", "元数据:", "可用性: 可用的", "默认启用: true", "只读: false", "必需: false"]),
      "YAML reading rows lost field punctuation, native values or their original field grouping."
    )
    const yamlLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", yamlFieldsDocument.document.uri, 1000)
    assert(
      yamlLenses.filter((lens) => lens.command?.title === " ").length === 5,
      "YAML fields before the final line did not reserve one reading row each; the final field uses the tail attachment."
    )
    assert(yamlFieldsDocument.document.getText() === yamlFieldsSource && !yamlFieldsDocument.document.isDirty, "YAML reading changed source.")
    const beforeYamlBlock = (await requests()).length
    const preservedYaml = owner.browse.inspect(yamlFieldsDocument.document.uri)!.units.filter((unit) => unit.display?.start !== 0)
    yamlFieldsDocument.editor.selection = new vscode.Selection(0, 0, 1, 0)
    assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.retranslateBlock"), "YAML block retranslation was not accepted.")
    await waitFor(() => owner.browse.inspect(yamlFieldsDocument.document.uri)?.status === "ready", "YAML block retranslation")
    const yamlBlockRequests = (await requests()).slice(beforeYamlBlock)
    assert(yamlBlockRequests.reduce((sum, request) => sum + (request.count ?? 0), 0) === 2, "YAML block retranslation did not target exactly the field key and value.")
    assert(
      preservedYaml.every((preserved) => owner.browse.inspect(yamlFieldsDocument.document.uri)!.units.some((unit) => unit === preserved)),
      "YAML block selection refreshed a neighbour at its exclusive end."
    )
    assert(yamlFieldsDocument.document.getText() === yamlFieldsSource && !yamlFieldsDocument.document.isDirty, "YAML block retranslation changed source.")
    checks.push("browse selection retranslation refreshes a complete YAML field while excluding the next row and preserving native values")
    yamlFieldsDocument.editor.selection = new vscode.Selection(0, 2, 0, 2)
    const yamlRequests = (await requests()).length
    const yamlHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", yamlFieldsDocument.document.uri, new vscode.Position(0, 2))
    assert(values(yamlHover).includes("名称"), "Standalone YAML hover did not resolve its scalar unit.")
    yamlFieldsDocument.editor.selection = new vscode.Selection(0, 2, 0, 2)
    assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.translateAndReplace"), "Standalone YAML cursor replacement failed.")
    assert(yamlFieldsDocument.document.getText() === yamlFieldsSource.replace("name", '"名称"'), "Standalone YAML replacement changed native values or unrelated fields.")
    assert((await requests()).length === yamlRequests, "Standalone YAML hover or replacement discarded the scalar cache.")
    await vscode.commands.executeCommand("undo")
    assert(yamlFieldsDocument.document.getText() === yamlFieldsSource, "Standalone YAML replacement could not be undone.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    checks.push("standalone YAML reading preserves colons and true/false values; scalar hover and cursor replacement reuse cache and support undo")
  } finally {
    await config.update("preserveTerms", beforeScalarTerms, vscode.ConfigurationTarget.Global)
  }

  const invalidYaml = await open("invalid-yaml.yml", "yaml", "name: [invalid")
  const beforeInvalidYaml = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await waitFor(() => owner.browse.inspect(invalidYaml.document.uri)?.status === "error", "invalid standalone YAML")
  assert(
    owner.browse.inspect(invalidYaml.document.uri)!.errors.includes("yaml-invalid") && (await requests()).length === beforeInvalidYaml,
    "Invalid YAML fell back to string translation."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("invalid standalone YAML retains source, reports a parsing error and sends no translation request")

  const foldedSource = "---\ndescription: >-\n  Read the original document.\n---"
  const foldedDocument = await open("folded-scalar.md", "markdown", foldedSource)
  await updateObserved("logDetails", true)
  const foldedLogStart = output!.getText().length
  await start(foldedDocument.document, 2)
  await vscode.commands.executeCommand("commentTranslatePlus.retranslate")
  await waitFor(() => {
    const text = output!.getText().slice(foldedLogStart)
    return text.includes("folded-scalar.md · 任务完成") && text.includes("--- assistant（finish_reason=stop） ---") && text.includes("阅读原始文档。")
  }, "YAML model response in the output document")
  const foldedLog = output!
    .getText()
    .slice(foldedLogStart)
    .split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m)
    .filter((entry) => entry.includes("] folded-scalar.md · "))
    .join("")
  const foldedSystems = new Set([...foldedLog.matchAll(/system=(S\d+)/g)].map((match) => match[1]))
  const systemDefinitions = [...output!.getText().matchAll(/--- system (S\d+) ---\r?\n([\s\S]*?)(?=\r?\n--- user ---)/g)]
  assert(
    systemDefinitions.some((match) => foldedSystems.has(match[1])) && foldedLog.includes("description: >-"),
    "YAML diagnostics lost the referenced system definition or original field syntax in the request."
  )
  assert(!foldedLog.includes("--- 原文与译文 ---"), "YAML diagnostics repeated source and translation pairs.")
  await updateObserved("logDetails", false)
  checks.push("YAML request diagnostics show model responses without source/translation pairs while references retain original block syntax")
  const foldedHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", foldedDocument.document.uri, new vscode.Position(2, 4))
  const foldedText = values(foldedHover)
  assert(foldedText.includes("阅读原始文档。") && !foldedText.includes(">-"), "Folded scalar hover retained its serialization header or lost its value.")
  assert(foldedDocument.document.getText() === foldedSource && !foldedDocument.document.isDirty, "Folded scalar display changed the source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("folded YAML block values show complete translated hover text without the >- header or source edits")

  await config.update("hover.enabled", false, vscode.ConfigurationTarget.Global)
  const replaceCommand = () => vscode.commands.executeCommand<boolean>("commentTranslatePlus.translateAndReplace")
  const selectedSource = "const before = 1;\r\n// prefix Read the original document. suffix %20\r\nconst after = 2;"
  const selectedTarget = await open("command replacement (中文 %25).ts", "typescript", selectedSource)
  selectedTarget.editor.selection = new vscode.Selection(1, 10, 1, 37)
  assert(selectedTarget.document.getText(selectedTarget.editor.selection) === "Read the original document.", "Selection fixture missed its translation target.")
  assert(await replaceCommand(), "Selection translation/replacement failed while hover was disabled.")
  assert(
    selectedTarget.document.getText() === selectedSource.replace("Read the original document.", "阅读原始文档。"),
    "Selection replacement changed surrounding code, CRLF or percent text."
  )
  await vscode.commands.executeCommand("undo")
  await waitFor(() => selectedTarget.document.getText() === selectedSource, "selection command undo")
  const cachedSelectionRequests = (await requests()).length
  selectedTarget.editor.selection = new vscode.Selection(1, 10, 1, 37)
  assert((await replaceCommand()) && (await requests()).length === cachedSelectionRequests, "Selection replacement failed to reuse its validated cache.")
  await vscode.commands.executeCommand("undo")
  await waitFor(() => selectedTarget.document.getText() === selectedSource, "cached selection command undo")
  checks.push("translate-and-replace prioritizes one selection independently of hover, preserves surrounding CRLF/code and reuses cache with native undo")

  for (const [file, language, source, position, expected] of [
    [
      "command-comment.ts",
      "typescript",
      "const before = 1;\n// Read the original document.\nconst after = 2;",
      new vscode.Position(1, 9),
      "const before = 1;\n// 阅读原始文档。\nconst after = 2;"
    ],
    ["command-string.ts", "typescript", 'const prompt = "Read the original document.";', new vscode.Position(0, 21), 'const prompt = "阅读原始文档。";'],
    ["command-block.rs", "rust", "/* Keep `sourceId` unchanged. */", new vscode.Position(0, 8), "/* 保留 `sourceId` unchanged. */"],
    ["command-doc.ts", "typescript", "/**\r\n * Keep `sourceId` unchanged.\r\n */", new vscode.Position(1, 8), "/**\r\n * 保留 `sourceId` unchanged.\r\n */"],
    ["command-quote.md", "markdown", '"Read the original document."', new vscode.Position(0, 8), '"阅读原始文档。"'],
    ["command-link.md", "markdown", "[Read the original document.](https://example.com)", new vscode.Position(0, 8), "[阅读原始文档。](https://example.com)"],
    ["command-markdown.md", "markdown", "# Read the original document.\n\nKeep `sourceId` unchanged.", new vscode.Position(0, 8), "# 阅读原始文档。\n\nKeep `sourceId` unchanged."],
    [
      "command-yaml.md",
      "markdown",
      "---\ndescription: |\n  Read the complete field.\n  Keep both lines together.\n---",
      new vscode.Position(2, 9),
      "---\ndescription: |\n  阅读完整字段。\n  Keep both lines together.\n---"
    ]
  ] as const) {
    const target = await open(file, language, source)
    target.editor.selection = new vscode.Selection(position, position)
    assert(await replaceCommand(), "Cursor unit replacement failed: " + file)
    assert(target.document.getText() === expected, "Cursor replacement damaged syntax or another source unit: " + file + " → " + target.document.getText())
    await vscode.commands.executeCommand("undo")
    await waitFor(() => target.document.getText() === source, file + " command undo")
  }
  checks.push("cursor replacement resolves comments, optional strings, Markdown and complete YAML scalar units without changing neighbors")

  const cachedCommand = await open("command-browse-cache.md", "markdown", "Read the original document. CachedCommand")
  await start(cachedCommand.document, 1)
  const cachedCommandRequests = (await requests()).length
  assert((await replaceCommand()) && (await requests()).length === cachedCommandRequests, "A ready cursor unit ignored its browse translation.")
  assert(cachedCommand.document.getText() === "阅读原始文档。 CachedCommand", "Cached command translation did not replace its source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await vscode.commands.executeCommand("undo")
  await waitFor(() => cachedCommand.document.getText() === "Read the original document. CachedCommand", "browse cache command undo")
  const failedCommand = await open("command-invalid-result.md", "markdown", "Read the original document. InvalidCommand")
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: true }) })
  const failedCommandRequests = (await requests()).length
  try {
    assert((await replaceCommand()) === false, "A missing result was accepted as an edit.")
    assert(failedCommand.document.getText() === "Read the original document. InvalidCommand" && !failedCommand.document.isDirty, "Failed translation altered the source.")
    assert((await requests()).length === failedCommandRequests + 3, "Command translation bypassed the bounded attempt budget.")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broken: false }) })
  }
  checks.push("translate-and-replace uses ready browse results without HTTP and failed protocol results exhaust bounded attempts without source edits")

  const offline = await open("command-no-target.ts", "typescript", "const value = 1;\n   ")
  const offlineRequests = (await requests()).length
  offline.editor.selection = new vscode.Selection(0, 6, 0, 6)
  assert((await replaceCommand()) === false, "An executable-code cursor became a translation target.")
  offline.editor.selection = new vscode.Selection(1, 0, 1, 3)
  assert((await replaceCommand()) === false, "Whitespace selection was translated.")
  offline.editor.selections = [new vscode.Selection(0, 0, 0, 5), new vscode.Selection(0, 6, 0, 11)]
  assert((await replaceCommand()) === false, "Multiple selections triggered a batch source edit.")
  const readonlyCommandUri = vscode.Uri.parse("command-readonly:/source.md")
  const readonlyCommandProvider = vscode.workspace.registerTextDocumentContentProvider("command-readonly", { provideTextDocumentContent: () => "Read the original document." })
  try {
    const document = await vscode.workspace.openTextDocument(readonlyCommandUri)
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false })
    assert((await replaceCommand()) === false && !document.isDirty, "Readonly source accepted a translation command edit.")
    assert((await requests()).length === offlineRequests, "Invalid/readonly targets still issued HTTP requests.")
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
  } finally {
    readonlyCommandProvider.dispose()
  }
  await updateObserved("activeProfile", "unchanged")
  const unchangedCommand = await open("command-unchanged.md", "markdown", "AcmeSDK keeps its original product name.")
  const unchangedVersion = unchangedCommand.document.version
  assert((await replaceCommand()) && unchangedCommand.document.version === unchangedVersion && !unchangedCommand.document.isDirty, "An unchanged command result created an edit.")
  const unchangedInputHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unchangedCommand.document.getText())))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  const unchangedCommandRequests = (await requests()).filter((request) => request.model === "unchanged-fixture" && request.inputFingerprint === unchangedInputHash).length
  const unchangedCommandResult = await replaceCommand()
  const afterUnchangedCommand = (await requests()).filter((request) => request.model === "unchanged-fixture" && request.inputFingerprint === unchangedInputHash)
  assert(
    unchangedCommandResult && afterUnchangedCommand.length === unchangedCommandRequests,
    "An unchanged command result was not cached: " +
      JSON.stringify({
        result: unchangedCommandResult,
        before: unchangedCommandRequests,
        after: afterUnchangedCommand.length,
        active: vscode.window.activeTextEditor?.document.uri.toString(),
        version: unchangedCommand.document.version,
        unchangedVersion,
        requests: afterUnchangedCommand.slice(unchangedCommandRequests)
      })
  )
  await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
  checks.push("translate-and-replace rejects code cursors, blank/multiple selections and readonly targets offline; unchanged results succeed without edits and stay cached")

  for (const reason of ["edit", "profile", "cancel", "hidden"] as const) {
    const source = "Read the original document. CommandStale " + reason
    const target = await open("command-stale-" + reason + ".md", "markdown", source)
    const beforeRequest = (await requests()).length
    await control(true)
    try {
      const pending = replaceCommand()
      await waitFor(async () => (await requests()).length > beforeRequest, reason + " command HTTP started")
      if (reason === "edit") assert(await target.editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "User edit. ")), "Pending command edit failed.")
      else if (reason === "profile") await config.update("activeProfile", "other", vscode.ConfigurationTarget.Global)
      else if (reason === "cancel") await vscode.commands.executeCommand("commentTranslatePlus.cancel")
      else await open("command-neighbor.md", "markdown", "Neighbor remains unchanged.")
      await control(false)
      assert((await pending) === false, "An invalidated command replaced source: " + reason)
      assert(target.document.getText() === (reason === "edit" ? "User edit. " + source : source), "A late command wrote stale translation: " + reason)
    } finally {
      await control(false)
      if (reason === "profile") await config.update("activeProfile", "test", vscode.ConfigurationTarget.Global)
    }
  }
  checks.push("pending translate-and-replace discards edited, reconfigured, cancelled or hidden source snapshots")
  await config.update("hover.enabled", true, vscode.ConfigurationTarget.Global)
  await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  const selectedList = "- Read the original\r\n  document. SelectionListOne\r\n- Keep `sourceId`\r\n  unchanged. SelectionListTwo"
  const selectedListSource = "# Outside selection\r\n\r\n" + selectedList + "\r\n\r\nUnselected neighbour."
  const selectedListTarget = await open("hover-selected-list.md", "markdown", selectedListSource)
  const selectedListStart = selectedListSource.indexOf(selectedList)
  const selectedListRange = new vscode.Selection(selectedListTarget.document.positionAt(selectedListStart), selectedListTarget.document.positionAt(selectedListStart + selectedList.length))
  selectedListTarget.editor.selection = selectedListRange
  const beforeSelectedList = (await requests()).length
  const selectedListHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", selectedListTarget.document.uri, new vscode.Position(2, 5))
  const expectedSelectedList = "- 阅读原始文档。 SelectionListOne\r\n- 保留 `sourceId` unchanged. SelectionListTwo"
  assert(values(selectedListHover).includes(expectedSelectedList), "Multiline selected-list hover failed to reassemble both translations and source CRLF boundaries.")
  assert(selectedListTarget.document.getText() === selectedListSource && !selectedListTarget.document.isDirty, "Selected-list hover edited the source.")
  const selectedListRequests = (await requests()).slice(beforeSelectedList)
  const selectedListFingerprints = await Promise.all(["Read the original document. SelectionListOne", "Keep `sourceId` unchanged. SelectionListTwo"].map(requestFingerprint))
  const selectedListItems = selectedListRequests.flatMap((request) => request.itemFingerprints ?? (request.inputFingerprint ? [request.inputFingerprint] : []))
  assert(
    selectedListItems.length === 2 &&
      selectedListFingerprints.every((fingerprint) => selectedListItems.includes(fingerprint)) &&
      selectedListRequests.every((request) => !request.retryFeedbackIncluded),
    "Selected-list translation sent a block boundary/prefix as prose, included a neighbour or required a retry."
  )
  const afterSelectedListHover = (await requests()).length
  assert(await replaceCommand(), "Selected-list command replacement failed after hover.")
  assert(
    selectedListTarget.document.getText() === selectedListSource.replace(selectedList, expectedSelectedList) && (await requests()).length === afterSelectedListHover,
    "Selected-list replacement changed unselected text or failed to reuse each hover item's cache."
  )
  await vscode.commands.executeCommand("undo")
  await waitFor(() => selectedListTarget.document.getText() === selectedListSource, "selected-list replacement undo")
  checks.push("multiline Markdown selection hover and replacement translate list bodies separately, retain CRLF/list structure, share item caches and undo one captured range")
  const partialSelectedSource = "- Read the original document. PartialSelectedReady\r\n- Keep [code-only-no-request](./examples/development/code-only.md) unchanged."
  const partialSelected = await open("hover-partial-selected-list.md", "markdown", partialSelectedSource)
  partialSelected.editor.selection = new vscode.Selection(new vscode.Position(0, 0), partialSelected.document.positionAt(partialSelectedSource.length))
  await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ damageLink: true }) })
  try {
    const partialHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", partialSelected.document.uri, new vscode.Position(0, 5))
    assert(
      values(partialHover).includes(partialSelectedSource.replace("Read the original document.", "阅读原始文档。")),
      "A failed selected-list item hid its accepted neighbour or replaced the damaged item instead of preserving source."
    )
    assert(partialSelected.document.getText() === partialSelectedSource && !partialSelected.document.isDirty, "Partial selected-list hover wrote the source.")
  } finally {
    await fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ damageLink: false }) })
  }
  const beforePartialSelectionRepair = (await requests()).length
  const repairedSelectedHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", partialSelected.document.uri, new vscode.Position(0, 5))
  assert(
    values(repairedSelectedHover).includes(partialSelectedSource.replace("Read the original document.", "阅读原始文档。").replace("Keep ", "保留 ")),
    "Repeating a partial selection hover failed to repair the unresolved item."
  )
  const partialSelectionRepairs = (await requests()).slice(beforePartialSelectionRepair)
  assert(partialSelectionRepairs.length === 1 && partialSelectionRepairs[0].count === 1, "Repairing a partial selection submitted its already completed neighbour.")
  checks.push("partial selected-list hover retains failed source, displays accepted neighbours and retries only unresolved items using the shared cache")
  const hoverReferenceSource = "Read the original document. SingleHoverTarget"
  const hoverReference = await open("hover-unit-reference.md", "markdown", hoverReferenceSource)
  const beforeSingleHover = (await requests()).length
  const singleHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", hoverReference.document.uri, new vscode.Position(0, 10))
  const singleFingerprint = await requestFingerprint("Read the original document. SingleHoverTarget")
  const singleRequests = (await requests()).slice(beforeSingleHover).filter((request) => request.inputFingerprint === singleFingerprint)
  assert(values(singleHover).includes("阅读原始文档") && singleRequests.length === 1 && singleRequests[0].count === 1, "Hover submitted an unrelated source unit.")
  assert(singleRequests[0].referenceIncluded === false && singleRequests[0].contextCharacters === 0, "Duplicate hover source appeared as reference content.")
  const neighbourSource = hoverReferenceSource + "\n\nKeep this neighbouring rule as context only."
  const neighbourReference = await open("hover-neighbour-reference.md", "markdown", neighbourSource)
  const beforeNeighbourHover = (await requests()).length
  const neighbourHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", neighbourReference.document.uri, new vscode.Position(0, 10))
  const neighbourRequests = (await requests()).slice(beforeNeighbourHover).filter((request) => request.inputFingerprint === singleFingerprint)
  assert(values(neighbourHover).includes("阅读原始文档") && neighbourRequests.length === 1 && neighbourRequests[0].count === 1, "Neighbour context caused hover to translate another item.")
  assert(neighbourRequests[0].contextFingerprint === (await requestFingerprint(neighbourSource)), "An isolated hover lost its complete neighbouring source window.")
  checks.push("isolated hover retains complete neighbouring context while translating only its target; duplicate standalone source remains omitted")
  const titledReference = await open("hover-title-reference.md", "markdown", "# Useful document title\n\nRead the original document. TitledHoverTarget")
  const beforeTitledHover = (await requests()).length
  assert(
    values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", titledReference.document.uri, new vscode.Position(2, 10))).includes("阅读原始文档"),
    "Titled hover failed."
  )
  const titledFingerprint = await requestFingerprint("Read the original document. TitledHoverTarget")
  const titledRequests = (await requests()).slice(beforeTitledHover).filter((request) => request.inputFingerprint === titledFingerprint)
  assert(
    titledRequests.length === 1 && titledRequests[0].count === 1 && titledRequests[0].referenceIncluded === true,
    "A meaningful distinct title reference was dropped or a neighbor was submitted."
  )
  assert((titledRequests[0].contextCharacters ?? 0) <= 2000 && (titledRequests[0].inputCharacters ?? 0) <= 12000, "Hover exceeded actual reference/prompt budgets.")
  const scopedSource =
    "# Scoped reference guide\n\n**R**ead [the guide][guide] and keep `sourceId` unchanged.\n\n| Field | Description |\n| --- | --- |\n| Source | Read [the guide][guide]. |\n| Target | Keep `targetId` unchanged. |\n\n```typescript\nconst untouched = 'Do not translate this fenced example.';\n```\n\n[guide]: https://example.com/guide"
  const scopedReference = await open("scoped-unit-references.md", "markdown", scopedSource)
  const scopedUnits = (await owner.documents.parse(scopedReference.document, true)).groups.flatMap((group) => group.units)
  assert(scopedUnits.length === 9, "The real TypeScript grammar did not extract the fenced string.")
  const previousScopedAdaptive = config.get<boolean>("adaptiveBatching")
  const previousScopedItems = config.get<number>("initialItemsPerRequest")
  await updateObserved("adaptiveBatching", false)
  await updateObserved("initialItemsPerRequest", 20)
  try {
    const beforeScopedReference = (await requests()).length
    const scopedResult = await owner.translations.translate(scopedReference.document, { units: scopedUnits }, new AbortController().signal)
    assert(scopedResult.size === 9, "Scoped requests lost source units.")
    const scopedRequests = (await requests()).slice(beforeScopedReference)
    const paragraphReference = "# Scoped reference guide\n\n" + scopedUnits[1].text
    const paragraphReferenceFingerprint = await requestFingerprint("")
    assert(
      scopedRequests.some((request) => request.count === 2 && request.contextFingerprint === paragraphReferenceFingerprint),
      "Masked paragraph reference lost its original source or included an unrelated table."
    )
    const fencedReferenceFingerprint = await requestFingerprint(paragraphReference + "\n\nconst untouched = 'Do not translate this fenced example.';")
    assert(
      scopedRequests.some((request) => request.count === 1 && request.contextFingerprint === fencedReferenceFingerprint),
      "Fenced string reference lost its title/section introduction or included unrelated table rows."
    )
    assert(scopedReference.document.getText() === scopedSource && !scopedReference.document.isDirty, "Reference selection modified source.")
  } finally {
    await updateObserved("adaptiveBatching", previousScopedAdaptive)
    await updateObserved("initialItemsPerRequest", previousScopedItems)
  }
  const previousHoverStrings = config.get<boolean>("hover.strings")
  await config.update("hover.strings", true, vscode.ConfigurationTarget.Global)
  try {
    const isolatedFence = await open(
      "isolated-fence-reference.md",
      "markdown",
      "# Isolated fence guide\n\n```typescript\nconst message = 'Read the original document. IsolatedFence';\n```"
    )
    const beforeFenceHover = (await requests()).length
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", isolatedFence.document.uri, new vscode.Position(3, 24))
    assert(values(hover).includes("阅读原始文档"), "Independent fenced string hover failed.")
    const fingerprint = await requestFingerprint("# Isolated fence guide\n\nconst message = 'Read the original document. IsolatedFence';")
    const sent = (await requests()).slice(beforeFenceHover)
    assert(sent.length === 1 && sent[0].count === 1 && sent[0].contextFingerprint === fingerprint, "Independent fenced hover depends on another unit to supply its outer title.")
  } finally {
    await config.update("hover.strings", previousHoverStrings, vscode.ConfigurationTarget.Global)
  }
  checks.push("default semantic requests retain masked original context and fenced titles independently, including single-string hover")
  const localReferenceSource = "# " + "General ".repeat(120) + "\n\n- Billing: statements and invoices for customer accounts.\n  - Read the original document."
  const localReference = await open("local-meaning-reference.md", "markdown", localReferenceSource)
  const beforeLocalReference = (await requests()).length
  assert(
    values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", localReference.document.uri, new vscode.Position(3, 12))).includes("阅读原始文档"),
    "Local reference hover failed."
  )
  const localSent = (await requests()).slice(beforeLocalReference)
  const localFingerprint = await requestFingerprint("- Billing: statements and invoices for customer accounts.")
  assert(localSent.length === 1 && localSent[0].count === 1 && localSent[0].contextFingerprint === localFingerprint, "A distant title displaced the hovered target's direct parent.")
  assert(localReference.document.getText() === localReferenceSource && !localReference.document.isDirty, "Local reference selection changed source.")
  const introductionSource = "# Electrical manual\n\n## Read the original document.\n\nApply an electrical charge to the capacitor."
  const introduction = await open("heading-meaning-reference.md", "markdown", introductionSource)
  const beforeIntroduction = (await requests()).length
  assert(
    values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", introduction.document.uri, new vscode.Position(2, 12))).includes("阅读原始文档"),
    "Heading introduction hover failed."
  )
  const introductionSent = (await requests()).slice(beforeIntroduction)
  const introductionFingerprint = await requestFingerprint("# Electrical manual\n\nApply an electrical charge to the capacitor.")
  assert(
    introductionSent.length === 1 && introductionSent[0].count === 1 && introductionSent[0].contextFingerprint === introductionFingerprint,
    "A heading hover omitted its own introduction or submitted the introduction for translation."
  )
  assert(introduction.document.getText() === introductionSource && !introduction.document.isDirty, "Heading reference selection changed source.")
  checks.push("single-target hover prioritizes local meaning under budget and uses a heading's immediate introduction without modifying source")
  await updateObserved("maxContextCharacters", 0)
  const disabledReference = await open("hover-reference-disabled.md", "markdown", "# Another useful title\n\nRead the original document. ContextDisabledHover")
  const beforeDisabledReference = (await requests()).length
  assert(
    values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", disabledReference.document.uri, new vscode.Position(2, 10))).includes("阅读原始文档"),
    "Hover failed with references disabled."
  )
  const disabledFingerprint = await requestFingerprint("Read the original document. ContextDisabledHover")
  const disabledRequests = (await requests()).slice(beforeDisabledReference).filter((request) => request.inputFingerprint === disabledFingerprint)
  assert(disabledRequests.length === 1 && disabledRequests[0].count === 1 && disabledRequests[0].referenceIncluded === false, "Zero reference budget still submitted reference content.")
  await updateObserved("maxContextCharacters", 2000)
  checks.push("hover sends only its target, omits duplicate source references, retains a distinct title and obeys final input/reference budgets including zero")
  const policy = {
    adaptiveBatching: false,
    batchBySemanticScope: false,
    initialItemsPerRequest: 2,
    initialRequestCharacters: 10000,
    batchGrowthSuccesses: 1,
    batchGrowthItems: 2,
    batchGrowthFactor: 1.5,
    batchShrinkFactor: 0.25,
    maxTranslationAttempts: 2,
    maxUnitContextCharacters: 1500,
    maxConcurrentRequests: 1
  }
  const previous = Object.fromEntries(Object.keys(policy).map((key) => [key, config.get(key)]))
  try {
    for (const [key, value] of Object.entries(policy)) await config.update(key, value, vscode.ConfigurationTarget.Global)
    const paragraphs = Array.from({ length: 6 }, (_, index) => "Read the original document. ConfiguredPolicy" + index)
    const source = paragraphs.map((text, index) => "# Policy section " + index + "\n\n" + text).join("\n\n")
    const target = await open("configured-request-policy.md", "markdown", source)
    const parsed = await owner.documents.parse(target.document)
    const units = parsed.groups.flatMap((group) => group.units).filter((unit) => unit.text.startsWith("Read"))
    // Keep all source units at the same background priority so this case
    // isolates configured batch limits from viewport tier boundaries.
    await open("configured-policy-idle.txt", "plaintext", "No translation requested.")
    const before = (await requests()).length
    const result = await owner.translations.translate(target.document, { units }, new AbortController().signal)
    assert(result.size === 6 && [...result.values()].every((text) => text.includes("阅读原始文档")), "Configured policy lost translations.")
    const fingerprints = await Promise.all([0, 2, 4].map((index) => requestFingerprint(paragraphs.slice(index, index + 2).join("\n\n%%\n\n"))))
    const sent = (await requests()).slice(before).filter((request) => fingerprints.includes(request.inputFingerprint ?? ""))
    assert(sent.length === 3 && sent.every((request) => request.count === 2), "Native settings did not retain fixed two-item batches across semantic scopes.")
    checks.push("native settings configure fixed batch targets and allow batching across semantic scopes without losing results")
    const longTitle = "# Policy reference " + "x".repeat(1200)
    const referenceTarget = await open("configured-unit-reference.md", "markdown", longTitle + "\n\nRead the original document. ConfiguredLongReference")
    const fingerprint = await requestFingerprint("Read the original document. ConfiguredLongReference")
    const beforeReference = (await requests()).length
    assert(
      values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", referenceTarget.document.uri, new vscode.Position(2, 10))).includes("阅读原始文档"),
      "Configured reference hover failed."
    )
    const referenceRequests = (await requests()).slice(beforeReference).filter((request) => request.inputFingerprint === fingerprint)
    assert(referenceRequests.length === 1 && referenceRequests[0].contextCharacters === longTitle.length, "A configured unit reference above 1000 characters was still discarded.")
    await updateObserved("maxUnitContextCharacters", 0)
    const beforeDisabledUnit = (await requests()).length
    assert(
      values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", referenceTarget.document.uri, new vscode.Position(2, 10))).includes("阅读原始文档"),
      "Reference policy change lost hover translation."
    )
    const disabledUnitRequests = (await requests()).slice(beforeDisabledUnit).filter((request) => request.inputFingerprint === fingerprint)
    assert(disabledUnitRequests.length === 1 && disabledUnitRequests[0].contextCharacters === 0, "Changing the unit reference budget reused the old reference or hover result.")
    checks.push("native unit reference settings accept more than 1000 characters and disabling them invalidates prior hover reference selection")
  } finally {
    for (const [key, value] of Object.entries(previous)) await config.update(key, value, vscode.ConfigurationTarget.Global)
  }
  const shellsBody = "Read the original document. LocalShell"
  const shellsSource = '"' + shellsBody + '"\n\n**' + shellsBody + "**\n\n[" + shellsBody + "](https://example.com)"
  const shells = await open("local-shells.md", "markdown", shellsSource)
  const beforeShells = (await requests()).length
  await start(shells.document, 3)
  const bodyFingerprint = await requestFingerprint(shellsBody)
  const shellRequests = (await requests()).slice(beforeShells).filter((request) => request.itemFingerprints?.includes(bodyFingerprint))
  assert(
    shellRequests.flatMap((request) => request.itemFingerprints ?? []).length === 3 &&
      shellRequests.every((request) => request.itemFingerprints?.every((value) => value === bodyFingerprint)),
    "Whole quotes, emphasis or link wrappers reached the translation body."
  )
  assert(
    owner.browse.inspect(shells.document.uri)!.units.every((unit) => unit.translation === unit.text.replace("Read the original document.", "阅读原始文档。")),
    "A local wrapper was lost while rendering translated prose."
  )
  const shellsBeforeHover = (await requests()).length
  const shellHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", shells.document.uri, new vscode.Position(0, 10))
  const shellPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(shells.document.uri))
  await waitFor(() => shellPreview.getText().includes("[阅读原始文档。 LocalShell](https://example.com)"), "locally restored wrapper preview")
  assert(
    values(shellHover).includes("阅读原始文档。") && (await requests()).length === shellsBeforeHover && shells.document.getText() === shellsSource && !shells.document.isDirty,
    "Hover or preview lost local wrappers, bypassed cache or edited source."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("local quote, emphasis and link shells share restored browse, hover and Markdown preview results without source edits")

  await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  await config.update("hover.strings", true, vscode.ConfigurationTarget.Global)
  await config.update("browse.comments", true, vscode.ConfigurationTarget.Global)
  await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  const prefixSource = "- Read task/context fields.\r\n\r\n2. Read input/output fields."
  const prefixes = await open("slash-prefixes.md", "markdown", prefixSource)
  prefixes.editor.selection = new vscode.Selection(0, 0, 0, prefixes.document.lineAt(0).text.length)
  const prefixPosition = new vscode.Position(0, 8)
  const beforePrefixHover = (await requests()).length
  const prefixHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", prefixes.document.uri, prefixPosition)
  assert(values(prefixHover).includes("- 读取任务/上下文字段。") && !values(prefixHover).includes("- - "), "Selected Markdown hover lost its local prefix or rejected Chinese slash prose.")
  const prefixFingerprint = await requestFingerprint("Read task/context fields.")
  const prefixRequests = (await requests()).slice(beforePrefixHover)
  assert(prefixRequests.length === 1 && prefixRequests[0].itemFingerprints?.[0] === prefixFingerprint, "Selected Markdown sent its list marker or retried a recoverable response.")
  assert(
    values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", prefixes.document.uri, prefixPosition)).includes("- 读取任务/上下文字段。"),
    "Repeated selected hover lost its translation."
  )
  assert((await requests()).length === beforePrefixHover + 1, "Repeated selected hover bypassed the validated cache.")
  prefixes.editor.selection = new vscode.Selection(prefixPosition, prefixPosition)
  await start(prefixes.document, 2)
  const prefixResults = owner.browse.inspect(prefixes.document.uri)!.units
  assert(
    prefixResults[0].translation === "- 读取任务/上下文字段。" && prefixResults[1].translation === "2. 读取输入/输出字段。",
    "Browse duplicated a list prefix or accepted the model's reset numbering."
  )
  const prefixPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(prefixes.document.uri))
  await waitFor(() => prefixPreview.getText() === "- 读取任务/上下文字段。\r\n\r\n2. 读取输入/输出字段。", "locally restored list prefix preview")
  assert(prefixes.document.getText() === prefixSource && !prefixes.document.isDirty, "Prefix recovery edited the original document.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push(
    "Markdown selection hover omits list prefixes, repairs echoed markers and caches Chinese slash prose; browse and preview retain original ordered numbering without source edits"
  )
  for (const newline of ["\n", "\r\n"]) {
    const lines = ["# Fenced guide", ""]
    for (const language of ["js", "ts", "py", "rust"]) {
      const declaration = language === "py" ? 'value = "Read the original document."' : (language === "rust" ? "let" : "const") + ' value = "Read the original document.";'
      lines.push(
        "```" + language,
        (language === "py" ? "# " : "// ") + "Read the original document.",
        declaration,
        language === "py" ? "untouched = 1" : (language === "rust" ? "let" : "const") + " untouched = 1;",
        "```",
        ""
      )
    }
    lines.push(
      newline === "\n" ? "````mdown" : "````markdown",
      "Read the original document.",
      "",
      "```yml",
      "title: Read the original document.",
      "enabled: true",
      "description: >-",
      "  Read the original document.",
      "```",
      "````",
      "",
      "> ```javascript",
      "> /*",
      "> Read the original document.",
      "> Keep `sourceId` unchanged.",
      "> */",
      "> ```"
    )
    const source = lines.join(newline)
    const target = await open(newline === "\n" ? "embedded-lf.md" : "embedded-crlf.md", "markdown", source)
    const parsed = await owner.documents.parse(target.document)
    const units = parsed.groups.flatMap((group) => group.units)
    assert(
      parsed.errors.length === 0 && units.filter((unit) => unit.kind === "comment").length === 6 && !units.some((unit) => unit.kind === "string"),
      "Fenced language aliases lost comments or ignored the default string setting."
    )
    assert(
      units.every((unit) => source.slice(unit.start, unit.end) === unit.text),
      "Embedded units do not own their exact source ranges."
    )
    await start(target.document, units.length)
    const snapshot = owner.browse.inspect(target.document.uri)!
    assert(
      snapshot.units
        .filter((unit) => unit.kind === "comment")
        .every((unit) => unit.translation.includes(unit.text.includes("Read the original document.") ? "阅读原始文档。" : "保留 `sourceId` unchanged.")),
      "Real TextMate grammars did not translate fenced JS/TS, Python, Rust or quoted multiline comments."
    )
    const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(target.document.uri))
    await waitFor(() => preview.getText().includes('title: "阅读原始文档。"') && preview.getText().includes("> 阅读原始文档。"), "embedded native Markdown preview")
    assert(
      preview.getText().includes('const value = "Read the original document.";') && preview.getText().includes('"启用": true') && preview.getText().includes("const untouched = 1;"),
      "Fenced preview changed unrequested strings, native YAML data or executable code."
    )
    const stringOffset = source.indexOf('"Read the original document."') + 5
    const stringHover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", target.document.uri, target.document.positionAt(stringOffset))
    assert(values(stringHover).includes("阅读原始文档。"), "Fenced string hover incorrectly depends on browse.strings.")
    const quotedHover = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      target.document.uri,
      target.document.positionAt(source.lastIndexOf("> Read the original document.") + 5)
    )
    assert(
      values(quotedHover).includes("```javascript") && values(quotedHover).includes("阅读原始文档。") && !values(quotedHover).includes("\n> "),
      "Fenced comment hover did not use its own language or leaked outer quote prefixes."
    )
    const comment = units.find((unit) => unit.kind === "comment")!
    target.editor.selection = new vscode.Selection(target.document.positionAt(comment.start + 4), target.document.positionAt(comment.start + 4))
    assert(await vscode.commands.executeCommand("commentTranslatePlus.translateAndReplace"), "Fenced comment cursor replacement was rejected by whole-document validation.")
    assert(
      target.document.getText() === source.slice(0, comment.start) + comment.text.replace("Read the original document.", "阅读原始文档。") + source.slice(comment.end),
      "Fenced replacement changed its container or neighbouring code."
    )
    await vscode.commands.executeCommand("undo")
    await waitFor(() => target.document.getText() === source && !target.document.isDirty, "embedded replacement undo")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await config.update("browse.comments", false, vscode.ConfigurationTarget.Global)
    await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
    const strings = (await owner.documents.parse(target.document)).groups.flatMap((group) => group.units)
    assert(
      !strings.some((unit) => unit.kind === "comment") && strings.filter((unit) => unit.kind === "string").length === 4,
      "Fenced browse settings did not isolate strings from comments."
    )
    await start(target.document, strings.length)
    assert(
      owner.browse
        .inspect(target.document.uri)!
        .units.filter((unit) => unit.kind === "string")
        .every((unit) => unit.translation.includes("阅读原始文档。")),
      "Enabled fenced strings were not translated."
    )
    assert(target.document.getText() === source && !target.document.isDirty, "Embedded reading or preview wrote to the source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await config.update("browse.comments", true, vscode.ConfigurationTarget.Global)
    await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
  }
  checks.push(
    "fenced JS/TS, Python and Rust comments/optional strings, nested Markdown/YAML and quoted multiline comments share reading, hover, native preview and undoable cursor replacement under LF/CRLF"
  )

  const documentationTarget = await open("embedded-documentation.ts", "typescript", "const value = 1;")
  const documentationSource = "```ts\n// Read the original document.\n```"
  const documentation = vscode.languages.registerHoverProvider("typescript", { provideHover: () => new vscode.Hover(new vscode.MarkdownString(documentationSource)) })
  await config.update("hover.documentation", true, vscode.ConfigurationTarget.Global)
  try {
    const hovers = values(await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", documentationTarget.document.uri, new vscode.Position(0, 8)))
    assert(
      hovers.includes(documentationSource) && hovers.includes("```ts\n// 阅读原始文档。\n```") && documentationTarget.document.getText() === "const value = 1;",
      "Language-service Markdown did not translate embedded comments while retaining the original documentation and source."
    )
  } finally {
    documentation.dispose()
    await config.update("hover.documentation", false, vscode.ConfigurationTarget.Global)
  }
  checks.push("language-service Markdown documentation translates fenced code comments through the same parser and retains the original hover and source")

  const reviewSource = "Prefer the quiet reading room near the north entrance. Visitors can borrow a printed map at the counter and return it before leaving the building."
  for (const model of ["language-review-fixture", "language-choice-fixture", "language-recovery-fixture"]) {
    const scenarioSource = reviewSource + " Review scenario: " + model + "."
    const fingerprint = await requestFingerprint(scenarioSource)
    await config.update("profiles", [{ id: "review", provider: "openai", apiUrl: origin + "/v1/chat/completions", model, apiKey: "mock-test" }], vscode.ConfigurationTarget.Global)
    await config.update("activeProfile", "review", vscode.ConfigurationTarget.Global)
    const target = await open(model + ".md", "markdown", scenarioSource)
    const before = (await requests()).length
    await start(target.document, 1)
    const sent = (await requests()).slice(before).filter((request) => request.model === model && request.inputFingerprint === fingerprint)
    const attempts = model === "language-recovery-fixture" ? 3 : 2
    assert(
      sent.length === attempts && !sent[0].retryFeedbackIncluded && sent.slice(1).every((request) => request.retryFeedbackIncluded && request.retryFeedbackCompact),
      "Language recovery lost its compact correction or attempt bound: " + JSON.stringify({ model, sent })
    )
    const translated = owner.browse.inspect(target.document.uri)!.units[0].translation
    assert(
      model === "language-choice-fixture" ? translated === scenarioSource : translated.includes("优先选择"),
      "A soft language review forced a rewrite or lost the corrected translation."
    )
    assert(target.document.getText() === scenarioSource && !target.document.isDirty, "Language review modified source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await start(target.document, 1)
    assert(
      (await requests()).slice(before).filter((request) => request.model === model && request.inputFingerprint === fingerprint).length === attempts,
      "A reviewed result was not cached."
    )
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  }
  checks.push(
    "language recovery uses compact single-item feedback, retains unchanged wording, retries English rewrites until corrected and caches only accepted results without editing source"
  )

  await config.update(
    "profiles",
    [{ id: "rewrite", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "language-rewrite-fixture", apiKey: "mock-test" }],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "rewrite", vscode.ConfigurationTarget.Global)
  const rewriteSource = reviewSource + " Review scenario: repeated rewrite."
  const rewriteFingerprint = await requestFingerprint(rewriteSource)
  const rewriteTarget = await open("language-rewrite.md", "markdown", rewriteSource)
  const beforeRewrite = (await requests()).length
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await waitFor(() => owner.browse.inspect(rewriteTarget.document.uri)?.status === "error", "other-language rewrites exhaust recovery")
  const rewriteState = owner.browse.inspect(rewriteTarget.document.uri)!
  const rewriteSent = (await requests()).slice(beforeRewrite).filter((request) => request.model === "language-rewrite-fixture" && request.inputFingerprint === rewriteFingerprint)
  assert(rewriteState.units.length === 0 && rewriteState.failedUnits.length === 1 && rewriteSent.length === 3, "An English rewrite was completed or bypassed the attempt limit.")
  assert(
    rewriteSent.slice(1).every((request) => request.retryFeedbackCompact),
    "A single-item failure sent batch labels or diagnostic codes."
  )
  assert(rewriteTarget.document.getText() === rewriteSource && !rewriteTarget.document.isDirty, "Exhausted language recovery edited source.")
  await vscode.commands.executeCommand("commentTranslatePlus.retry")
  await waitFor(
    () => owner.browse.inspect(rewriteTarget.document.uri)?.status === "error" && owner.browse.inspect(rewriteTarget.document.uri)?.pending === 0,
    "manual language retry exhausts recovery"
  )
  assert(
    (await requests()).slice(beforeRewrite).filter((request) => request.model === "language-rewrite-fixture" && request.inputFingerprint === rewriteFingerprint).length === 6,
    "The rejected English rewrite was cached."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("repeated English rewrites remain failed, uncached and invisible as translations; manual retry requests the source again and preserves the document")

  await config.update(
    "profiles",
    [{ id: "transport", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "transport-retry-fixture", apiKey: "mock-test" }],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "transport", vscode.ConfigurationTarget.Global)
  await config.update("initialItemsPerRequest", 2, vscode.ConfigurationTarget.Global)
  await config.update("maxItemsPerRequest", 2, vscode.ConfigurationTarget.Global)
  await config.update("adaptiveBatching", false, vscode.ConfigurationTarget.Global)
  const transportSource = "1. Read the original document. TransportRetryCase.\n2. Keep `sourceId` unchanged."
  const transportTarget = await open("transport-retry.md", "markdown", transportSource)
  const beforeTransport = (await requests()).length
  await start(transportTarget.document, 2)
  const transportFingerprint = await requestFingerprint("Read the original document. TransportRetryCase.\n\n%%\n\nKeep `sourceId` unchanged.")
  const transportRequests = (await requests()).slice(beforeTransport).filter((request) => request.inputFingerprint === transportFingerprint)
  assert(
    transportRequests.length === 2 && transportRequests.every((request) => request.count === 2 && !request.retryFeedbackIncluded),
    "A temporary network failure changed the model batch or added model feedback: " + JSON.stringify(transportRequests)
  )
  assert(transportRequests[0].messageFingerprint === transportRequests[1].messageFingerprint, "Network recovery changed the original messages.")
  assert(transportTarget.document.getText() === transportSource && !transportTarget.document.isDirty, "Network recovery modified source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await start(transportTarget.document, 2)
  assert((await requests()).filter((request) => request.inputFingerprint === transportFingerprint).length === 2, "Results recovered from a network failure were not cached.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("temporary connection failures resend identical messages without model feedback or shrinking, then cache successful results and preserve source")

  await config.update(
    "profiles",
    [{ id: "log-recovery", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "log-recovery-fixture", apiKey: "mock-test" }],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "log-recovery", vscode.ConfigurationTarget.Global)
  for (const [name, source, expected, attempts] of [
    ["heading", "## Sources", "## 来源", 2],
    ["inline", "Read `sourceId` unchanged. InlineCodeToleranceCase.", "阅读 sourceChanged，并标记 `body/html`。", 1],
    ["bold", "The village library has **illustrated** travel guides.", "乡村图书馆提供带插图的旅行指南。", 1],
    ["bold-list", "- A shelf label `catalog.txt` is **recommended**.", "- 建议提供书架标签 `catalog.txt`。", 1],
    ["italic", "The village library has *illustrated* travel guides.", "乡村图书馆提供带插图的旅行指南。", 1],
    ["italic-list", "- A shelf label `catalog.txt` is _recommended_.", "- 建议提供书架标签 `catalog.txt`。", 1],
    ["style", "**Reading room closes at dusk.** Return borrowed maps to the desk.", "**阅览室于黄昏关闭。** 请将借阅的地图归还服务台。", 1],
    ["code", "- The `Example reading room:` label points to the northern gallery beside the garden.", "- `Example reading room:` 标签指向花园旁的北侧画廊。", 1]
  ] as const) {
    const target = await open("log-recovery-" + name + ".md", "markdown", source)
    const unit = (await owner.documents.parse(target.document)).groups.flatMap((group) => group.units)[0]
    const fingerprint = await requestFingerprint(prepareTranslation(unit, 32).text)
    const before = (await requests()).length
    const sent = async () => (await requests()).slice(before).filter((request) => request.model === "log-recovery-fixture" && request.inputFingerprint === fingerprint)
    await start(target.document, 1)
    assert(
      owner.browse.inspect(target.document.uri)!.units[0].translation === expected,
      "Synthetic output failed to recover: " + JSON.stringify({ name, expected, actual: owner.browse.inspect(target.document.uri)!.units[0].translation })
    )
    assert((await sent()).length === attempts, "Synthetic output consumed unnecessary retries: " + name)
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", target.document.uri, new vscode.Position(0, name === "heading" ? 4 : 8))
    assert(values(hover).includes(expected.replace(/^## |^- /u, "")), "Hover lost the recovered translation: " + name)
    const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(target.document.uri))
    await waitFor(() => preview.getText().includes(expected), "synthetic output preview: " + name)
    assert((await sent()).length === attempts, "Hover or preview did not reuse the recovered cache: " + name)
    assert(target.document.getText() === source && !target.document.isDirty, "Log recovery changed source: " + name)
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    await start(target.document, 1)
    assert((await sent()).length === attempts, "Reopening browse resubmitted the recovered unit: " + name)
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  }
  checks.push("appended corrections, omitted inline emphasis and style/code wrapper recovery share cached browse, hover and native preview results without source edits or excess attempts")

  await config.update(
    "profiles",
    [{ id: "history", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "retry-history-fixture", apiKey: "mock-test" }],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "history", vscode.ConfigurationTarget.Global)
  await config.update("batchShrinkFactor", 1, vscode.ConfigurationTarget.Global)
  const historySource = "1. Keep `firstId_abcdefghijklmnopqrstuvwxyz_123456789` unchanged.\n2. Read the original document. JointRetryHistoryCase."
  const historyTarget = await open("joint-retry-history.md", "markdown", historySource)
  const historyFingerprint = await requestFingerprint("Keep <CTP0> unchanged.\n\n%%\n\nRead the original document. JointRetryHistoryCase.")
  const beforeHistory = (await requests()).length
  await start(historyTarget.document, 2)
  const historyRequests = (await requests()).slice(beforeHistory).filter((request) => request.model === "retry-history-fixture" && request.inputFingerprint === historyFingerprint)
  assert(
    historyRequests.length === 2 && !historyRequests[0].previousOutputFingerprint,
    "A jointly failed batch did not retry together or fabricated first-attempt history: " + JSON.stringify(historyRequests)
  )
  assert(
    historyRequests[1].previousOutputFingerprint === (await requestFingerprint("第一项丢失了代码。\n%%\n")) && historyRequests[1].numberedCorrections,
    "Joint recovery lost the exact assistant response or per-item corrections: " + JSON.stringify(historyRequests)
  )
  assert(
    owner.browse.inspect(historyTarget.document.uri)!.units.every((unit) => unit.translation.includes("保留") || unit.translation.includes("阅读")),
    "Joint recovery published an invalid result."
  )
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await start(historyTarget.document, 2)
  assert(
    (await requests()).slice(beforeHistory).filter((request) => request.model === "retry-history-fixture" && request.inputFingerprint === historyFingerprint).length === 2,
    "Jointly recovered results were not cached."
  )
  assert(historyTarget.document.getText() === historySource && !historyTarget.document.isDirty, "Retry history changed source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("multiple failed units retry together with the exact assistant response and numbered corrections, retain source and cache the accepted batch")

  await config.update(
    "profiles",
    [{ id: "request-echo", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "request-echo-fixture", apiKey: "mock-test" }],
    vscode.ConfigurationTarget.Global
  )
  await config.update("activeProfile", "request-echo", vscode.ConfigurationTarget.Global)
  await config.update("maxItemsPerRequest", 4, vscode.ConfigurationTarget.Global)
  await config.update("initialItemsPerRequest", 4, vscode.ConfigurationTarget.Global)
  const echoSource = Array.from({ length: 4 }, (_, index) => `${index + 1}. Read the original document. RequestEchoCase${index}.`).join("\n")
  const echoTarget = await open("request-echo.md", "markdown", echoSource)
  const echoFingerprints = new Set(await Promise.all(Array.from({ length: 4 }, (_, index) => requestFingerprint(`Read the original document. RequestEchoCase${index}.`))))
  const echoRecords = async () => (await requests()).filter((request) => request.model === "request-echo-fixture" && request.itemFingerprints?.some((item) => echoFingerprints.has(item)))
  await start(echoTarget.document, 4)
  const echoUnits = owner.browse.inspect(echoTarget.document.uri)!.units
  assert(
    echoUnits.every((unit) => unit.translation.includes("阅读原始文档。")),
    "Request echo tails were accepted as unchanged results."
  )
  const echoRequests = await echoRecords()
  assert(
    echoRequests.length === 6 && echoRequests.slice(2).every((request) => !request.previousOutputFingerprint),
    "Contaminated history survived request echo recovery: " + JSON.stringify(echoRequests.map((request) => ({ count: request.count, previousOutput: request.previousOutputFingerprint })))
  )
  const echoPreview = await vscode.workspace.openTextDocument(markdownPreviewUri(echoTarget.document.uri))
  await waitFor(() => echoPreview.getText().includes("阅读原始文档。"), "request echo preview")
  assert(!echoPreview.getText().includes("Read the original document."), "Preview retained untranslated request echo tails.")
  assert(echoTarget.document.getText() === echoSource && !echoTarget.document.isDirty, "Request echo recovery modified source.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  await start(echoTarget.document, 4)
  assert((await echoRecords()).length === echoRequests.length, "Recovered echo results were not cached.")
  await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  checks.push("request echoes reject all copied source tails before caching, recover without contaminated history and share complete browse/preview results without source edits")
  await config.update("initialItemsPerRequest", 2, vscode.ConfigurationTarget.Global)
  await config.update("maxItemsPerRequest", 2, vscode.ConfigurationTarget.Global)

  for (const newline of ["\n", "\r\n"]) {
    const source = "> Read the original \t" + newline + ">   document. Keep `sourceId` unchanged."
    const target = await open(newline === "\n" ? "folded-prose-lf.md" : "folded-prose-crlf.md", "markdown", source)
    const before = (await requests()).length
    await start(target.document, 1)
    const fingerprint = await requestFingerprint("Read the original document. Keep `sourceId` unchanged.")
    assert(
      (await requests()).slice(before).some((request) => request.itemFingerprints?.includes(fingerprint)),
      "Multiline prose still sent line markers, continuation prefixes or multiple joining spaces."
    )
    const expected = "> 阅读原始文档。 保留 `sourceId` unchanged."
    assert(owner.browse.inspect(target.document.uri)!.units[0].translation === expected, "Folded browse output restored obsolete source line positions.")
    const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(target.document.uri))
    await waitFor(() => preview.getText() === expected, "folded multiline prose preview")
    assert(target.document.getText() === source && !target.document.isDirty, "Folding reading prose wrote to source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
  }
  checks.push("LF/CRLF multiline prose sends one joining space without line placeholders and shares folded browse/native preview results while preserving source")
  for (const newline of ["\n", "\r\n"]) {
    const commands = [
      "sample-reader set media dark",
      "sample-reader --session <name> ...",
      "sample-reader --json ...",
      "sample-reader open <url>",
      "sample-reader <command> --help",
      "sample-reader is visible @e1"
    ].join(newline)
    const bare = await owner.documents.parseSource(commands, "shellscript")
    assert(bare.groups.length === 0, "Shell commands, options and placeholder fragments became translation units.")
    const code = [
      commands,
      "# Read the original document.",
      'sample-reader find title "Read the original document." click',
      "echo 'Read the original document.'",
      'sample-reader find role button click --name="Read the original document."'
    ].join(newline)
    for (const fenced of [false, true]) {
      const source = fenced ? ["```" + (newline === "\n" ? "bash" : "sh"), code, "```"].join(newline) : code
      const target = await open("shell-arguments-" + (newline === "\n" ? "lf" : "crlf") + (fenced ? ".md" : ".sh"), fenced ? "markdown" : "shellscript", source)
      const units = (await owner.documents.parse(target.document, true)).groups.flatMap((group) => group.units)
      const prose = units.filter((unit) => prepareTranslation(unit, 32).needsTranslation)
      assert(
        prose.length === 4 && prose.every((unit) => prepareTranslation(unit, 32).text === "Read the original document."),
        "Shell extraction lost comments or quoted prose, or included executable arguments."
      )
      assert(
        units.every((unit) => source.slice(unit.start, unit.end) === unit.text) && !(await owner.documents.target(target.document, source.indexOf("media"))),
        "Shell units lost source ownership or exposed a command argument as a cursor translation target."
      )
      await config.update("browse.strings", true, vscode.ConfigurationTarget.Global)
      await start(target.document, units.length)
      assert(
        owner.browse
          .inspect(target.document.uri)!
          .units.filter((unit) => prose.some((item) => item.id === unit.id))
          .every((unit) => unit.translation.includes("阅读原始文档。")),
        "Shell comments or quoted strings did not translate through the normal reading chain."
      )
      if (fenced) {
        const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(target.document.uri))
        await waitFor(() => preview.getText() === source.replaceAll("Read the original document.", "阅读原始文档。"), "Shell preview retains executable syntax")
        owner.preview.close(preview.uri)
      }
      assert(target.document.getText() === source && !target.document.isDirty, "Shell reading or preview edited its source.")
      await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
      await config.update("browse.strings", false, vscode.ConfigurationTarget.Global)
    }
  }
  checks.push(
    "real Shell grammar preserves commands, options and placeholders while translating comments and quoted strings in files and fenced previews under LF/CRLF without source edits"
  )

  for (const [index, url] of ["https://example.com/sheets/d/<BOOK_ID>/", "https://example.com/sheets/d/{item}", "https://example.com/sheets/d/${item}"].entries()) {
    const source = "Open the sample sheet at " + url + "."
    const expected = "打开示例表格 " + url + "。"
    const target = await open("template-url-" + index + ".md", "markdown", source)
    const before = (await requests()).length
    await start(target.document, 1)
    assert(owner.browse.inspect(target.document.uri)!.units[0].translation === expected, "Template URL did not restore as a complete address.")
    const fingerprint = await requestFingerprint("Open the sample sheet at <CTP0>.")
    assert(
      (await requests()).slice(before).some((request) => request.itemFingerprints?.includes(fingerprint)),
      "Template URL was split into separate URL and parameter fragments."
    )
    const preview = await vscode.workspace.openTextDocument(markdownPreviewUri(target.document.uri))
    await waitFor(() => preview.getText() === expected, "complete template URL in native preview")
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", target.document.uri, new vscode.Position(0, 3))
    assert(values(hovers ?? []).includes(url), "Source hover lost the complete template URL.")
    assert(target.document.getText() === source && !target.document.isDirty, "Template URL reading wrote to source.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    const cached = (await requests()).length
    await start(target.document, 1)
    assert((await requests()).length === cached, "Template URL result was not shared with the reading cache.")
    await vscode.commands.executeCommand("commentTranslatePlus.toggleDocumentBrowseMode")
    owner.preview.close(preview.uri)
  }
  checks.push(
    "angle-bracket, brace and dollar-brace URL parameters use one CTP and restore exactly before Chinese punctuation across reading, source hover, native preview and cache without source edits"
  )
  const deletedSource = "<catalog_rules>\n- Read the original document.\n- Keep `sourceId` and [guide](https://example.com).\n\nCatalog ids: `__CATALOG_IDS__`.\n</catalog_rules>"
  const originalUri = vscode.Uri.parse("ctp-diff-original:/catalog-rules.md")
  const originalProvider = vscode.workspace.registerTextDocumentContentProvider(originalUri.scheme, { provideTextDocumentContent: () => deletedSource })
  try {
    const modified = await open("catalog-rules.md", "markdown", "<catalog_rules>\nCatalog ids: `__CATALOG_IDS__`.\n</catalog_rules>")
    await vscode.commands.executeCommand("vscode.diff", originalUri, modified.document.uri, "Catalog changes")
    const original = await vscode.workspace.openTextDocument(originalUri)
    await waitFor(() => vscode.window.visibleTextEditors.some((editor) => editor.document === original), "diff original editor")
    await owner.browse.start(original)
    await waitFor(() => owner.browse.inspect(originalUri)?.status === "ready" && owner.browse.inspect(originalUri)?.units.length === 3, "deleted XML-wrapped Markdown translation")
    const snapshot = owner.browse.inspect(originalUri)!
    assert(snapshot.units[0].translation.includes("阅读原始文档"), "Deleted Markdown inside XML delimiters was not translated.")
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", originalUri, new vscode.Position(1, 5))
    assert(values(hovers).includes("阅读原始文档"), "Diff original hover lost its translation.")
    assert(original.getText() === deletedSource && !original.isDirty, "Translation modified the read-only diff original.")
    assert(modified.document.getText() === "<catalog_rules>\nCatalog ids: `__CATALOG_IDS__`.\n</catalog_rules>", "Original translation changed the modified side.")
    checks.push("read-only diff original translates deleted Markdown inside XML delimiters and exposes source hover without editing either side")
  } finally {
    owner.browse.stop(originalUri, true)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    originalProvider.dispose()
  }
  return checks
}
