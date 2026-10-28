import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"
import { displayTranslations } from "../../src/documents/presentation.ts"
import { validateTranslation } from "../../src/documents/validation.ts"
import { prepareTranslation } from "../../src/documents/terms.ts"

/** Exercise the real grammar, document events and nested-fence cache through the production reader. */
export async function runParsing(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "@catalog_tool(",
      "    description=(",
      '        "Pack/unpack parcels before "',
      '        "visiting. Supports +, -, *, /, parentheses. "',
      '        "Read the map. Keep the ticket. "',
      '        "Compare red/blue labels. "',
      '        "Choose the shelf or "',
      '        "the documented default.\\n\\nReference shelves:\\n"',
      "        + render_shelf_catalog()",
      "    ),",
      ")"
    ].join(newline)
    const parsed = await owner.documents.parseSource(source, "python")
    const units = parsed.groups.flatMap((group) => group.units)
    const expected = [
      "Pack/unpack parcels before visiting. Supports +, -, *, /, parentheses. Read the map. Keep the ticket. Compare red/blue labels. Choose the shelf or the documented default.",
      "Reference shelves:"
    ]
    if (JSON.stringify(units.map((unit) => prepareTranslation(unit, 32).text)) !== JSON.stringify(expected)) throw Error("Adjacent Python literal sentence units drifted.")
    for (const unit of units) {
      const prepared = prepareTranslation(unit, 32)
      if (source.slice(unit.start, unit.end) !== unit.text || prepared.restore(prepared.text) !== unit.text) throw Error("Adjacent Python literal source mapping drifted.")
      const translated = prepared.restore("阅读目录。")
      if (validateTranslation(unit, translated)) throw Error("Adjacent Python literal translation rejected.")
    }
    const rows = displayTranslations(
      source,
      units.map((unit) => ({ ...unit, translation: prepareTranslation(unit, 32).restore("阅读目录。") }))
    )
    if (rows.length !== 1 || rows[0].translation !== "阅读目录。\n\n阅读目录。") throw Error("Same-line Python paragraphs lost their shared display block or decoded separator.")
  }
  for (const newline of ["\n", "\r\n"]) {
    for (const language of ["markdown", "typescript", "python"]) {
      const lines = ["Read the catalog.  ", "Keep the ticket.\t", "Read the next", "section before leaving."]
      const source = language === "python" ? '"""' + newline + lines.join(newline) + newline + '"""' : lines.map((line) => (language === "typescript" ? "// " : "") + line).join(newline)
      const parsed = await owner.documents.parseSource(source, language)
      const units = parsed.groups.flatMap((group) => group.units)
      const bodies = units.map((unit) => prepareTranslation(unit, 32).text)
      if (JSON.stringify(bodies) !== JSON.stringify(["Read the catalog.", "Keep the ticket.", "Read the next section before leaving."]))
        throw Error("Sentence-ending lines merged or unfinished continuation split: " + language)
      for (const unit of units) {
        const prepared = prepareTranslation(unit, 32)
        if (source.slice(unit.start, unit.end) !== unit.text || prepared.restore(prepared.text) !== unit.text) throw Error("Sentence boundary lost source ownership: " + language)
      }
    }
  }
  for (const newline of ["\n", "\r\n"]) {
    const lines = ["Read the catalog.  ", "Keep the ticket.\t", "Read the next", "section before leaving."]
    const cases = [
      { language: "typescript", source: "const notice = `" + newline + lines.join(newline) + newline + "`;" },
      { language: "typescript", source: ["/**", ...lines.map((line) => " * " + line), " */"].join(newline) },
      { language: "css", source: ["/*", ...lines, "*/"].join(newline) },
      ...["|", ">"].map((marker) => ({ language: "yaml", source: ["notice: " + marker, ...lines.map((line) => "  " + line)].join(newline) }))
    ]
    for (const { language, source } of cases) {
      const parsed = await owner.documents.parseSource(source, language)
      const units = parsed.groups.flatMap((group) => group.units).filter((unit) => prepareTranslation(unit, 32).text !== "notice")
      const bodies = units.map((unit) => prepareTranslation(unit, 32).text)
      if (JSON.stringify(bodies) !== JSON.stringify(["Read the catalog.", "Keep the ticket.", "Read the next section before leaving."]))
        throw Error("Multiline sentence boundaries drifted: " + language + " " + JSON.stringify(bodies))
      for (const unit of units) {
        const prepared = prepareTranslation(unit, 32)
        if (prepared.restore(prepared.text) !== unit.text) throw Error("Multiline sentence restoration drifted: " + language)
        const translated = prepared.restore(prepared.text.replaceAll("Read", "阅读").replaceAll("Keep", "保留"))
        if (validateTranslation(unit, translated)) throw Error("Multiline sentence translation rejected: " + language)
      }
      if (
        displayTranslations(
          source,
          units.map((unit) => ({ ...unit, translation: prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text.replaceAll("Read", "阅读").replaceAll("Keep", "保留")) }))
        ).length !== 3
      )
        throw Error("Multiline translations did not retain independent rows: " + language)
    }
  }
  const versions = [
    '# Read the catalog.\nnotice = f"""Read the original notice.\n{shelf["name"]}\nKeep the ticket.\n"""\n# Read the final notice.',
    '# Read the catalog.\nnotice = f"""Read the updated notice.\n{shelf["name"]}\nKeep the ticket.\n"""\n# Read the final notice.',
    '# Read the catalog.\nnotice = f"""Read the updated notice.\n"""\n# Keep the ticket.\n# Read the final notice.',
    '# Inserted introduction.\r\n# Read the catalog.\r\nnotice = ("Read the original "\r\n"notice before visiting.")\r\n# Read the final notice.'
  ]
  const uri = vscode.Uri.joinPath(workspace, "parse-state.py")
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(versions[0]))
  const document = await vscode.workspace.openTextDocument(uri)
  for (const source of versions) {
    const edit = new vscode.WorkspaceEdit()
    edit.set(uri, [
      vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source),
      vscode.TextEdit.setEndOfLine(source.includes("\r\n") ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)
    ])
    if (!(await vscode.workspace.applyEdit(edit))) throw Error("Could not apply parsing regression edit.")
    if (document.getText() !== source) throw Error("The native edit did not preserve the requested parsing workload and EOL.")
    const incremental = await owner.documents.parse(document, true)
    const fresh = await owner.documents.parseSource(source, "python")
    if (JSON.stringify(incremental) !== JSON.stringify(fresh)) throw Error("Incremental Python grammar state diverged from fresh parsing at version " + versions.indexOf(source))
    for (const unit of incremental.groups.flatMap((group) => group.units)) {
      const prepared = prepareTranslation(unit, 32)
      if (unit.text !== source.slice(unit.start, unit.end) || prepared.restore(prepared.text) !== unit.text)
        throw Error("Python source mapping or unchanged restoration drifted after an edit.")
    }
  }
  owner.documents.invalidate(uri)
  const stale = owner.documents.parse(document, true)
  owner.documents.invalidate(uri)
  let rejected = false
  try {
    await stale
  } catch (error) {
    rejected = error instanceof Error && error.message === "document-stale"
  }
  if (!rejected) throw Error("An invalidated same-version parse republished its cache entry.")
  await owner.documents.parse(document, true)
  const markdownUri = vscode.Uri.joinPath(workspace, "parse-fences.md")
  const markdown = (body: string) => ["Read the catalog.", "", "> ```python", ...body.split(/\r?\n/u).map((line) => "> " + line), "> ```", "", "Keep the ticket."].join("\r\n")
  await vscode.workspace.fs.writeFile(markdownUri, new TextEncoder().encode(markdown(versions[0])))
  const nested = await vscode.workspace.openTextDocument(markdownUri)
  await owner.documents.parse(nested, true)
  for (const body of versions.slice(1)) {
    const source = markdown(body)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(markdownUri, new vscode.Range(nested.positionAt(0), nested.positionAt(nested.getText().length)), source)
    if (!(await vscode.workspace.applyEdit(edit))) throw Error("Could not apply nested parsing regression edit.")
    const incremental = await owner.documents.parse(nested, true)
    const fresh = await owner.documents.parseSource(source, "markdown")
    if (JSON.stringify(incremental) !== JSON.stringify(fresh)) throw Error("Nested fence tokenization or source mapping diverged after an edit.")
  }
  return [
    "adjacent Python literals ignore physical source line breaks, split decoded paragraphs and preserve dynamic suffixes for LF and CRLF",
    "sentence endings ignore trailing whitespace and split Markdown, real comments and Python docstrings for LF and CRLF",
    "real Python grammar edits preserve incremental/fresh parity and exact unchanged restoration",
    "quoted Markdown fences isolate incremental grammar state and retain exact CRLF source ranges",
    "same-version invalidation rejects pending parsing and permits a fresh read"
  ]
}
