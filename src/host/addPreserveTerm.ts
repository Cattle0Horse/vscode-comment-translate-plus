import * as vscode from "vscode"
import { appendPreserveTerm, termSource } from "../documents/termFiles.ts"

/** Write to the configured target independently of the translation source list. */
export async function writePreserveTerm(resource: vscode.Uri | undefined, term: string, home?: string): Promise<boolean> {
  const path = vscode.workspace.getConfiguration("commentTranslatePlus", resource).get<unknown>("preserveTermsWriteFile")
  if (typeof path !== "string" || !path.trim()) throw Error("请先配置 preserveTermsWriteFile 保留词写入文件。")
  const folder = resource ? vscode.workspace.getWorkspaceFolder(resource)?.uri.toString() : undefined
  const uri = vscode.Uri.parse(termSource(path, folder, home))
  if (!/\.jsonc?$/iu.test(uri.path) || /^(?:https?|untitled):/u.test(uri.toString())) throw Error("请选择可写的 JSON/JSONC 文件。")
  if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) throw Error("所选文件系统只读。")
  let missing = false
  try {
    if ((await vscode.workspace.fs.stat(uri)).size > 2_000_000) throw Error("保留词文件超过 2 MB 上限。")
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error
    missing = true
  }
  if (missing && vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString()))
    throw Error("保留词文件已删除但仍在编辑器中打开，请先处理未保存修改并关闭该文件后重试。")
  let document = missing ? undefined : await vscode.workspace.openTextDocument(uri)
  if (document?.isDirty) throw Error("保留词文件有未保存的修改，请先保存或撤销后重试。")
  const text = document?.getText() ?? "[]"
  if (new TextEncoder().encode(text).byteLength > 2_000_000) throw Error("保留词文件超过 2 MB 上限。")
  const updated = appendPreserveTerm(text, uri.toString(), term)
  if (updated === text) return false
  if (new TextEncoder().encode(updated).byteLength > 2_000_000) throw Error("添加后保留词文件将超过 2 MB 上限。")
  const edit = new vscode.WorkspaceEdit()
  if (document) edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), updated)
  else {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."))
    edit.createFile(uri, { overwrite: false })
    edit.insert(uri, new vscode.Position(0, 0), updated)
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw Error("无法修改保留词文件，请检查文件权限后重试。")
  document ??= await vscode.workspace.openTextDocument(uri)
  if (!(await document.save())) {
    await vscode.window.showTextDocument(document)
    throw Error("保留词文件未能保存，已打开修改内容，请检查后手动保存。")
  }
  return true
}

export async function addPreserveTerm(home?: string): Promise<void> {
  const editor = vscode.window.activeTextEditor
  const resource = editor?.document.uri
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : ""
  const term =
    selected ||
    (await vscode.window.showInputBox({
      title: "添加保留词",
      prompt: "添加一条忽略大小写匹配的字面保留词，仅完整正文匹配时保留。",
      validateInput: (value) => (value.trim() ? undefined : "请输入非空保留词。")
    }))
  if (term === undefined) return
  try {
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", resource)
    if (config.get<unknown>("preserveTermsWriteFile", "") === "") {
      const file = await vscode.window.showSaveDialog({
        title: "首次选择保留词写入文件（将记住此路径）",
        saveLabel: "设为写入词表",
        filters: { 保留词文件: ["json", "jsonc"] }
      })
      if (!file) return
      const target =
        resource && vscode.workspace.getWorkspaceFolder(resource)
          ? vscode.ConfigurationTarget.WorkspaceFolder
          : vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
      await config.update("preserveTermsWriteFile", file.toString(), target)
    }
    const added = await writePreserveTerm(resource, term, home)
    void vscode.window.showInformationMessage((added ? "已添加保留词：" : "保留词已存在：") + JSON.stringify(term))
  } catch (error) {
    void vscode.window.showErrorMessage("添加保留词失败：" + (error instanceof Error ? error.message : "无法修改文件。"))
  }
}
