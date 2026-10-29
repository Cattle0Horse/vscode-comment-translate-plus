import * as vscode from "vscode"
import { displayMode, getTranslationSettings, isMarkdownDocument, profiles } from "./configuration.ts"
import { TranslationHover } from "../features/hover.ts"
import { MarkdownPreview } from "../features/preview.ts"
import { describeError } from "../model/diagnostics.ts"
import type { DocumentReader } from "./documents.ts"
import type { TranslationRuntime } from "./translations.ts"
import type { BrowseWorkspace } from "../features/browse/workspace.ts"
import type { SourceReplacementAction } from "../features/replacement.ts"
import { emptyPreserveTerms } from "../documents/terms.ts"

export class Controls implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  private readonly subscriptions: vscode.Disposable[] = []
  private disposed = false
  constructor(
    private readonly documents: DocumentReader,
    private readonly translations: TranslationRuntime,
    private readonly browse: BrowseWorkspace,
    private readonly hover: TranslationHover,
    private readonly preview: MarkdownPreview,
    private readonly replacement: SourceReplacementAction,
    private readonly retranslate: () => Promise<void>
  ) {
    const command = (id: string, action: (...args: unknown[]) => unknown) => this.subscriptions.push(vscode.commands.registerCommand("commentTranslatePlus." + id, action))
    const toggleDocumentBrowseMode = () => this.browse.toggle()
    command("toggleDocumentBrowseMode", toggleDocumentBrowseMode)
    command("toggleDocumentBrowseMode.active", toggleDocumentBrowseMode)
    command("cancel", () => {
      const uri = vscode.window.activeTextEditor?.document.uri
      if (uri) {
        this.browse.cancel(uri)
        this.hover.cancel(uri, "user-cancelled")
        this.replacement.cancel(uri, "user-cancelled")
        this.preview.cancel(uri, "user-cancelled")
      }
      return vscode.commands.executeCommand("editor.action.hideHover")
    })
    command("retranslate", () => this.retranslate())
    command("translateAll", () => this.browse.translateAll())
    command("retranslateBlock", () => this.browse.retranslateBlock())
    command("retranslatePreview", (value) => this.preview.retranslate(value))
    command("retry", () => {
      const uri = vscode.window.activeTextEditor?.document.uri
      if (uri) {
        this.browse.restart(uri)
        this.preview.update(uri)
      }
    })
    command("showErrors", () => this.translations.showErrors())
    command("showCacheUsage", () => this.translations.showCacheUsage())
    command("translateAndReplace", () => this.replacement.translateAndReplace())
    command("actions", () => this.actions())
    command("setLanguages", () => this.setLanguages())
    command("selectProfile", () => this.selectProfile())
    command("toggleMode", () => this.updateSetting("displayMode", displayMode(vscode.window.activeTextEditor?.document.uri) === "contrast" ? "inplace" : "contrast"))
    command("toggleHover", () => {
      const config = vscode.workspace.getConfiguration("commentTranslatePlus")
      return this.updateSetting("hover.enabled", !config.get<boolean>("hover.enabled", true))
    })
    command("toggleAuto", () => {
      const config = vscode.workspace.getConfiguration("commentTranslatePlus")
      return this.updateSetting("auto.enabled", !config.get<boolean>("auto.enabled", false))
    })
    command("addCurrentFileToAutoExclude", () => this.addCurrentFileRule("exclude"))
    command("addCurrentFileToAutoInclude", () => this.addCurrentFileRule("include"))
    command("preview", () => this.preview.open())
    command("settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:cattle-horse.vscode-comment-translate-plus"))

    this.status.name = "注释翻译+"
    this.status.command = "commentTranslatePlus.actions"
  }

  render(): void {
    if (this.disposed) return
    const document = vscode.window.activeTextEditor?.document
    const snapshot = document ? this.browse.inspect(document.uri) : undefined
    void vscode.commands.executeCommand("setContext", "commentTranslatePlus.supported", !!document && this.documents.supports(document))
    void vscode.commands.executeCommand("setContext", "commentTranslatePlus.markdown", !!document && isMarkdownDocument(document))
    const browsing = snapshot?.scope === "document"
    void vscode.commands.executeCommand("setContext", "commentTranslatePlus.browse", browsing)
    if (!document || !this.documents.supports(document)) {
      this.status.hide()
      return
    }
    let icon = browsing ? "eye" : "eye-closed"
    let suffix = ""
    let state = "未开启浏览"
    if (snapshot) {
      switch (snapshot.status) {
        case "working":
          icon = "loading~spin"
          suffix = " · 剩余 " + snapshot.loading.length
          state = "翻译中，当前剩余 " + snapshot.loading.length + " 项"
          break
        case "ready":
          state = browsing ? "浏览就绪" : "局部译文就绪"
          break
        case "cancelled":
          suffix = " · 已取消"
          state = "已取消"
          break
        case "error":
          icon = "warning"
          suffix = snapshot.failedUnits.length ? " · 重试 " + snapshot.failedUnits.length : " · 异常"
          state = snapshot.failedUnits.length ? snapshot.failedUnits.length + " 项需重试" : "浏览异常"
          break
      }
    }
    let label = "配置翻译"
    const details = ["注释翻译+：" + state]
    try {
      const settings = getTranslationSettings(document.uri, emptyPreserveTerms)
      label = settings.targetLanguage + suffix
      details.push("配置：" + settings.name, "语言：" + (settings.sourceLanguage === "auto" ? "自动检测" : settings.sourceLanguage) + " → " + settings.targetLanguage)
    } catch {
      /* Incomplete settings must not send requests or interrupt opening a file. */
      icon = "warning"
      details.push("翻译配置不完整或无效，请检查设置。")
    }
    if (snapshot) {
      const unchanged = snapshot.units.filter((unit) => unit.translation === unit.text).length
      details.push(snapshot.units.length - unchanged + " 段译文" + (unchanged ? " · " + unchanged + " 段保留原文" : ""), "已处理：" + snapshot.units.length + "/" + snapshot.total)
      if (snapshot.failedUnits.length) details.push("需重试：" + snapshot.failedUnits.length + " 项")
      for (const code of snapshot.errors) details.push(describeError(code))
    }
    details.push("点击打开操作菜单")
    this.status.text = "$(" + icon + ") " + label
    this.status.tooltip = details.join("\n")
    this.status.accessibilityInformation = { label: details.join("；") }
    this.status.show()
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
    await vscode.workspace.getConfiguration("commentTranslatePlus", vscode.window.activeTextEditor?.document.uri).update(key, value, target)
  }

  private async actions(): Promise<void> {
    const snapshot = vscode.window.activeTextEditor ? this.browse.inspect(vscode.window.activeTextEditor.document.uri) : undefined
    const items = [
      { label: "切换当前文档注释浏览模式", command: "toggleDocumentBrowseMode" },
      { label: "翻译全文", command: "translateAll" },
      { label: "重新翻译当前块", command: "retranslateBlock" }
    ]
    if (snapshot)
      items.push(
        {
          label: snapshot.status === "cancelled" ? "继续翻译" : "取消进行中的翻译",
          command: "cancel"
        },
        { label: "重新翻译当前文件", command: "retranslate" },
        { label: "重试失败批次", command: "retry" }
      )
    items.push(
      { label: "翻译并替换", command: "translateAndReplace" },
      { label: "添加保留词", command: "addPreserveTerm" },
      { label: "源语言与目标语言", command: "setLanguages" },
      { label: "选择翻译配置", command: "selectProfile" },
      { label: "切换对照 / 占位模式", command: "toggleMode" },
      { label: "开启 / 关闭悬停翻译", command: "toggleHover" },
      { label: "开启 / 关闭工作区自动注释浏览", command: "toggleAuto" },
      { label: "添加当前文件到自动翻译排除规则", command: "addCurrentFileToAutoExclude" },
      { label: "添加当前文件到自动翻译包含规则", command: "addCurrentFileToAutoInclude" }
    )
    if (vscode.window.activeTextEditor && isMarkdownDocument(vscode.window.activeTextEditor.document)) items.push({ label: "打开 Markdown 翻译预览", command: "preview" })
    items.push({ label: "查看缓存使用情况", command: "showCacheUsage" }, { label: "扩展设置", command: "settings" }, { label: "查看日志与错误", command: "showErrors" })
    const configured = vscode.workspace.getConfiguration("commentTranslatePlus", vscode.window.activeTextEditor?.document.uri).get<unknown>(
      "actions",
      items.map((item) => item.command)
    )
    if (!Array.isArray(configured)) {
      void vscode.window.showErrorMessage("commentTranslatePlus.actions 必须是操作 ID 数组。")
      return
    }
    const ordered = [...new Set(configured)].flatMap((id) => {
      const item = items.find((item) => item.command === id)
      return item ? [item] : []
    })
    const selected = await vscode.window.showQuickPick(ordered, {
      title: "注释翻译+",
      placeHolder: "当前文档的注释浏览操作"
    })
    if (selected) {
      const command = selected.command === "cancel" && snapshot?.status === "cancelled" ? "retry" : selected.command
      await vscode.commands.executeCommand("commentTranslatePlus." + command)
    }
  }

  private async addCurrentFileRule(kind: "include" | "exclude"): Promise<void> {
    const document = vscode.window.activeTextEditor?.document
    const folder = document && !document.isUntitled ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined
    if (!document || !folder) {
      void vscode.window.showWarningMessage("请先打开工作区内的文件，再添加自动翻译规则。")
      return
    }
    const pattern = vscode.workspace.asRelativePath(document.uri, false).replace(/[[\]*?{}]/g, (character) => "[" + character + "]")
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", document.uri)
    const key = "auto." + kind
    const rules = config.get<string[]>(key, kind === "include" ? ["**/*"] : [])
    try {
      await config.update(key, [...rules, pattern], vscode.ConfigurationTarget.WorkspaceFolder)
      const note = kind === "include" ? "；仍遵循自动翻译开关、排除规则和手动阅读状态" : ""
      void vscode.window.showInformationMessage("已添加当前文件到自动翻译" + (kind === "include" ? "包含" : "排除") + "规则：" + pattern + note)
    } catch (error) {
      void vscode.window.showErrorMessage("无法保存自动翻译规则：" + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async selectProfile(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      profiles(vscode.window.activeTextEditor?.document.uri).map((profile) => ({
        label: profile.name,
        description: profile.provider + (profile.model ? " · " + profile.model : ""),
        id: profile.id
      })),
      { title: "选择翻译配置" }
    )
    if (selected) await this.updateSetting("activeProfile", selected.id)
  }

  private async setLanguages(): Promise<void> {
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", vscode.window.activeTextEditor?.document.uri)
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "源语言",
          key: "sourceLanguage",
          fallback: "auto",
          prompt: "例如 en、zh-CN；auto 或留空自动识别。"
        },
        {
          label: "目标语言",
          key: "targetLanguage",
          fallback: "",
          prompt: "例如 zh-CN、en；留空使用 VS Code 界面语言。"
        }
      ],
      { title: "选择要修改的语言" }
    )
    if (!selected) return
    const value = await vscode.window.showInputBox({
      title: selected.label,
      prompt: selected.prompt,
      value: config.get<string>(selected.key, selected.fallback)
    })
    if (value !== undefined) await this.updateSetting(selected.key, value.trim())
  }

  dispose(): void {
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    this.status.dispose()
  }
}
