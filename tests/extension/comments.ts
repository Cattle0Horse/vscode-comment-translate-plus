import { validatedText } from "../support/assertions.ts"
import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { prepareTranslation } from "../../src/documents/terms.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw Error("Comment paragraph timed out: " + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runCommentParagraphs(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const records = async () => ((await (await fetch(origin + "/state")).json()) as { requests: { count: number }[] }).requests
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const previousStrings = config.inspect<boolean>("hover.strings")?.globalValue
  try {
    await config.update("hover.strings", true, vscode.ConfigurationTarget.Global)
    for (const newline of ["\n", "\r\n"]) {
      const source = ["def read_catalog():", '    """Catalog.', "", "        Read the original", "        document.", '    """'].join(newline)
      const document = await vscode.workspace.openTextDocument({ language: "python", content: source })
      await vscode.window.showTextDocument(document, { preview: false })
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, new vscode.Position(3, 12))
      const content = hovers.flatMap((hover) => hover.contents).find((item) => typeof item !== "string" && item.value.includes("阅读原始文档。"))
      assert(content && typeof content !== "string" && /(?:^|\n)```[^\n]*\n阅读原始文档。\n```/u.test(content.value), "Python hover retained source indentation: " + JSON.stringify(hovers))
      assert(document.getText() === source, "Python hover changed source indentation.")
    }
  } finally {
    await config.update("hover.strings", previousStrings, vscode.ConfigurationTarget.Global)
  }
  for (const [index, newline] of ["\n", "\r\n"].entries()) {
    const source = ["<<<<<<< HEAD", "// Read the original document.", "||||||| base", "// Keep its context.", "=======", "// Read the original document.", ">>>>>>> incoming"].join(newline)
    const uri = vscode.Uri.joinPath(workspace, "git-conflict-" + index + ".ts")
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    await vscode.commands.executeCommand("commentTranslatePlus.browse.toggle")
    await waitFor(() => owner.browse.inspect(uri)?.status === "ready" && owner.browse.inspect(uri)?.units.length === 3, "conflict browse")
    const units = owner.browse.inspect(uri)!.units
    assert(
      units.every((unit) => unit.text === source.slice(unit.start, unit.end) && !/[<>|=]{7}/u.test(validatedText(unit.translation))),
      "Conflict browse translated marker lines or shifted source ranges."
    )
    assert(document.getText() === source && !document.isDirty, "Conflict browsing changed source.")
    const start = document.positionAt(source.indexOf("Keep its context."))
    assert(
      await editor.edit((builder) => builder.replace(new vscode.Range(start, start.translate(0, "Keep its context.".length)), "Read the original document.")),
      "Conflict branch edit failed."
    )
    assert(!owner.browse.inspect(uri)!.units.some((unit) => unit.text.includes("Keep its context.")), "Editing a conflict branch left its stale translation visible.")
    await waitFor(() => owner.browse.inspect(uri)?.status === "ready" && owner.browse.inspect(uri)?.units.length === 3, "conflict edit refresh")
    assert(document.getText() === source.replace("Keep its context.", "Read the original document."), "Refreshing conflict browsing changed marker or branch source.")
    await vscode.commands.executeCommand("undo")
    await waitFor(() => document.getText() === source && owner.browse.inspect(uri)?.units.length === 3, "conflict edit undo")
    const resolved = "// Read the original document."
    assert(await editor.edit((builder) => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(source.length)), resolved)), "Resolving a conflict failed.")
    await waitFor(() => owner.browse.inspect(uri)?.status === "ready" && owner.browse.inspect(uri)?.units.length === 1, "resolved conflict refresh")
    assert(owner.browse.inspect(uri)!.units[0].text === resolved && document.getText() === resolved, "Resolved conflict retained obsolete branch ranges.")
    await vscode.commands.executeCommand("undo")
    await waitFor(() => document.getText() === source && owner.browse.inspect(uri)?.units.length === 3, "resolved conflict undo")
    owner.browse.stop(uri, false)
  }
  for (const [language, extension, prefix, code] of [
    ["typescript", "ts", "//", "const completed = 1;"],
    ["rust", "rs", "///", "let completed = 1;"],
    ["python", "py", "#", "completed = 1"],
    ["shellscript", "sh", "#", "completed=1"],
    ["sql", "sql", "--", "SELECT 1;"]
  ]) {
    for (const [index, newline] of ["\n", "\r\n"].entries()) {
      const source = ["  " + prefix + " Read the original", "  " + prefix + " document.", "  " + prefix + " -----------", "  " + prefix + " Keep its context.", code].join(newline)
      const uri = vscode.Uri.joinPath(workspace, "comment-paragraph-" + index + "." + extension)
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
      const document = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(document, { preview: false })
      const parsed = await owner.documents.parse(document)
      const units = parsed.groups.flatMap((group) => group.units)
      assert(units.length === 2 && units.every((unit) => unit.kind === "comment"), "Real grammar did not produce two comment paragraphs: " + language)
      const body = prepareTranslation(units[0], 32)
      assert(
        body.text === "Read the original document." && body.restore(body.text) === units[0].text,
        "Comment syntax reached paragraph prose or unchanged restoration lost bytes: " + language
      )
      await owner.browse.start(document)
      await waitFor(() => owner.browse.inspect(uri)?.status === "ready" && owner.browse.inspect(uri)?.units.length === 2, language + " browse")
      const first = owner.browse.inspect(uri)!.units[0]
      assert(first.translation === prefix + " 阅读原始文档。", "A translated paragraph kept continuation markers or lost comment syntax: " + language)
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)
      assert(
        lenses?.some((lens) => lens.range.start.line === 2) && !lenses.some((lens) => lens.range.start.line === 1),
        "Comment paragraph reserved a translation row between its source lines: " + language
      )
      const beforeHover = (await records()).length
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(1, prefix.length + 4))
      assert(
        hovers.some((hover) => hover.contents.some((content) => typeof content !== "string" && content.value.includes("阅读原始文档"))),
        "Continuation-line hover lost the paragraph: " + language
      )
      assert((await records()).length === beforeHover, "Continuation-line hover resubmitted the paragraph: " + language)
      assert(document.getText() === source && !document.isDirty, "Comment browsing modified source: " + language)
      assert(await editor.edit((builder) => builder.insert(document.lineAt(1).range.end, "x")), "Comment continuation edit failed.")
      const edited = owner.browse.inspect(uri)!
      assert(
        edited.units.length === 1 && edited.units[0].text.includes("Keep its context.") && edited.loading.length === 0,
        "Editing a continuation failed to invalidate the complete paragraph or removed its neighbour: " + language
      )
      await vscode.commands.executeCommand("undo")
      await waitFor(() => document.getText() === source && owner.browse.inspect(uri)?.units.length === 2, language + " edit undo")
      assert((await records()).length === beforeHover, "Undo before debounce requested a comment paragraph again: " + language)
      editor.selection = new vscode.Selection(1, prefix.length + 4, 1, prefix.length + 4)
      assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.replacement.translate"), "Continuation-line comment replacement failed: " + language)
      assert(
        document.getText() === source.slice(0, units[0].start) + first.translation + source.slice(units[0].end),
        "Comment replacement changed code or a neighbouring paragraph: " + language
      )
      assert((await records()).length === beforeHover, "Comment replacement bypassed its ready cache: " + language)
      await vscode.commands.executeCommand("undo")
      await waitFor(() => document.getText() === source, "comment paragraph replacement restores every source line in one undo: " + language)
      owner.browse.stop(uri, false)
    }
  }
  for (const [index, newline] of ["\n", "\r\n"].entries()) {
    for (const language of ["typescript", "javascript", "rust", "css"]) {
      const paragraphs = [
        "/**",
        " * The gallery's visits wait",
        " * for a guide's arrival",
        " *",
        " * Keep the visitor pass",
        " * for the next visit",
        " *",
        " * - Read the map",
        " *   before leaving",
        " * - Keep the guide",
        " */"
      ].join(newline)
      const parsed = await owner.documents.parseSource(paragraphs, language)
      const units = parsed.groups.flatMap((group) => group.units)
      assert(
        JSON.stringify(units.map((unit) => prepareTranslation(unit, 32).text)) ===
          JSON.stringify(["The gallery's visits wait for a guide's arrival", "Keep the visitor pass for the next visit", "- Read the map before leaving", "- Keep the guide"]),
        "Real block grammar merged blank paragraphs or list items: " + language
      )
      assert(
        units.every((unit) => prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text) === paragraphs.slice(unit.start, unit.end)),
        "Block paragraph mapping lost exact source: " + language
      )
    }
    const source = ["\t/**", "\t * Read the original", "\t * document.", "\t */", "const completed = 1;"].join(newline)
    const uri = vscode.Uri.joinPath(workspace, "block-comment-" + index + ".ts")
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    const parsed = await owner.documents.parse(document)
    const [unit] = parsed.groups.flatMap((group) => group.units)
    const prepared = prepareTranslation(unit, 32)
    assert(prepared.text === "Read the original document." && prepared.restore(prepared.text) === unit.text, "Real block grammar lost continuation prose or exact source restoration.")
    assert(source.slice(unit.end).startsWith(newline + "\t */"), "Real block grammar included the closing line in its last prose unit.")
    await owner.browse.start(document)
    await waitFor(() => owner.browse.inspect(uri)?.status === "ready", "block comment browse")
    const first = owner.browse.inspect(uri)!.units[0]
    assert(validatedText(first.translation)?.includes("阅读原始文档。"), "Block comment translation did not complete.")
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)
    assert(lenses?.some((lens) => lens.range.start.line === 3) && !lenses.some((lens) => lens.range.start.line === 4), "Block translation row was placed after its closing delimiter.")
    assert(document.getText() === source && !document.isDirty, "Block comment browsing modified source.")
    editor.selection = new vscode.Selection(2, 5, 2, 5)
    assert(await vscode.commands.executeCommand<boolean>("commentTranslatePlus.replacement.translate"), "Block comment continuation replacement failed.")
    assert(document.getText() === source.slice(0, unit.start) + first.translation + source.slice(unit.end), "Block comment replacement changed its closing delimiter or surrounding code.")
    await vscode.commands.executeCommand("undo")
    await waitFor(() => document.getText() === source, "block comment replacement undoes exactly")
    owner.browse.stop(uri, false)
  }
  return [
    "unresolved Git diff3 conflicts browse through the public command and mock HTTP, preserve all markers and source, and invalidate/refresh edited branch comments for LF and CRLF",
    "real TypeScript, JavaScript, Rust and CSS block comments share docstring paragraph and list continuation boundaries for LF and CRLF",
    "real TypeScript block comments place translation rows before standalone closing delimiters and preserve the shell through replacement and undo for LF and CRLF",
    "real TypeScript, Rust, Python, Shell and SQL grammars group consecutive standalone comments into paragraphs for LF and CRLF",
    "comment paragraphs share below-source rows, continuation hover, incremental edit invalidation and cached single-range replacement with one-step undo"
  ]
}
