import { mkdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { setTimeout as delay } from "node:timers/promises"
import manifest from "../package.json" with { type: "json" }

async function waitFor(check, message) {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(message)
    await delay(50)
  }
}

async function toggleMode(page) {
  await page.getByRole("button", { name: /段译文/ }).click()
  const input = page.locator(".quick-input-widget input")
  await input.fill("切换对照 / 占位模式")
  await input.press("Enter")
  await input.waitFor({ state: "hidden" })
}

async function attachments(page) {
  return page.locator(".view-lines span").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const box = element.getBoundingClientRect()
      if (!box.height) return []
      const output = []
      for (const side of ["before", "after"]) {
        const style = element.ownerDocument.defaultView.getComputedStyle(element, "::" + side)
        if (!style.content || ["none", "normal", '""'].includes(style.content)) continue
        let origin = box
        if (style.position === "absolute") {
          let parent = element
          while (parent && element.ownerDocument.defaultView.getComputedStyle(parent).position === "static") parent = parent.parentElement
          if (parent) origin = parent.getBoundingClientRect()
        }
        const transform = style.transform === "none" ? { m41: 0, m42: 0 } : new DOMMatrix(style.transform)
        output.push({
          side,
          text: style.content,
          x: origin.x + (parseFloat(style.left) || 0) + (parseFloat(style.marginLeft) || 0) + transform.m41,
          y: origin.y + (parseFloat(style.top) || 0) + transform.m42,
          height: parseFloat(style.height) || parseFloat(style.lineHeight) || box.height,
          top: style.top,
          font: style.fontSize,
          lineHeight: style.lineHeight,
          element: { x: box.x, y: box.y, height: box.height }
        })
      }
      return output
    })
  )
}

async function attachment(page, text) {
  let value
  await waitFor(async () => {
    value = (await attachments(page)).find((value) => value.text.includes(text))
    return !!value
  }, "Rendered translation was not found: " + text)
  return value
}

async function sourceGlyph(line, text) {
  return line.evaluate((element, text) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const start = node.textContent.indexOf(text)
      if (start < 0) continue
      const range = element.ownerDocument.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      const box = range.getBoundingClientRect()
      return { x: box.x, width: box.width }
    }
    throw Error("Source glyph was not found: " + text)
  }, text)
}

async function loadingIcons(page) {
  return page.locator(".view-lines span").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const style = element.ownerDocument.defaultView.getComputedStyle(element, "::after")
      if (!(style.content + style.backgroundImage).includes("loading.svg")) return []
      const url = (style.content + style.backgroundImage).match(/url\(["']?([^"')]+)["']?\)/)?.[1]
      return [{ content: style.content, background: style.backgroundImage, url, width: parseFloat(style.width), height: parseFloat(style.height) }]
    })
  )
}

export async function runUiChecks({ debugPort, port, origin, packaged }) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().startsWith(`http://localhost:${port}`))
  await mkdir("artifacts/ui", { recursive: true })
  try {
    if (!page) throw Error("Official Web host page not found.")
    await page.setViewportSize({ width: 1365, height: 900 })
    const screenshotPrefix = packaged ? "package-" : ""
    const screenshots = []

    async function capture(name) {
      const path = `artifacts/ui/${screenshotPrefix}${name}.png`
      await page.screenshot({ path, animations: "disabled" })
      screenshots.push(path)
    }

    await page.getByRole("button", { name: /2 段译文/ }).waitFor({ timeout: 30000 })
    const firstTranslation = await attachment(page, "阅读原始文档。")
    const secondTranslation = await attachment(page, "保留")
    await capture("browse")
    const checks = []
    const firstSource = page.locator(".view-lines .view-line").filter({ hasText: "Read" })
    const firstSourceBox = await firstSource.boundingBox()
    const secondSourceBox = await page.locator(".view-lines .view-line").filter({ hasText: "Keep" }).boundingBox()
    assert.ok(firstTranslation && firstSourceBox && secondTranslation && secondSourceBox)
    assert.ok(
      firstSourceBox.y + firstSourceBox.height <= firstTranslation.y &&
        firstTranslation.y + firstTranslation.height <= secondSourceBox.y &&
        secondSourceBox.y + secondSourceBox.height <= secondTranslation.y,
      "Translation rows overlap or precede their source paragraphs."
    )
    checks.push("translations appear below their matching editable source, including the final line without a trailing newline")
    const beforeLoadingGlyph = await sourceGlyph(page.locator(".view-lines .view-line").filter({ hasText: "Keep" }), "Keep")
    const control = (hold) => fetch(origin + "/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hold }) })
    await control(true)
    try {
      assert.equal(await page.getByRole("button", { name: "注释浏览操作", exact: true }).count(), 0, "The editor title still exposes the browse actions button.")
      assert.equal(await page.getByRole("button", { name: /^切换对照或占位模式/ }).count(), 0, "The editor title still exposes the mode switch button.")
      await page.getByRole("button", { name: /2 段译文/ }).click()
      await page.getByText("重新翻译当前文件", { exact: true }).click()
      await waitFor(async () => (await loadingIcons(page)).length === 2, "Pending source units did not show their loading icons.")
      const iconUrl = (await loadingIcons(page))[0].url
      assert.ok(iconUrl, "Rendered loading icon has no image URL.")
      assert.equal((await page.request.get(iconUrl)).status(), 200, "Rendered loading asset is unavailable in this build.")
      assert.ok(
        (await loadingIcons(page)).every((icon) => icon.width > 0 && icon.height > 0),
        "Loading icons occupy no visible area."
      )
      const pendingGlyph = await sourceGlyph(page.locator(".view-lines .view-line").filter({ hasText: "Keep" }), "Keep")
      assert.deepEqual(pendingGlyph, beforeLoadingGlyph, "Loading icons moved the original source text.")
      await capture("loading")
    } finally {
      await control(false)
    }
    await page.getByRole("button", { name: /2 段译文/ }).waitFor()
    await waitFor(async () => (await loadingIcons(page)).length === 0, "Completed translations retained loading icons.")
    checks.push("in-flight source units display the packaged animated icon without moving source glyphs, and completion removes it")
    await firstSource.hover({ position: { x: 90, y: firstSourceBox.height / 2 } })
    const hover = page.getByRole("tooltip").filter({ has: page.getByText("[注释翻译+]", { exact: true }) })
    await hover.waitFor()
    assert.ok((await hover.innerText()).includes("阅读原始文档"), "Native hover omitted the translated content.")
    await capture("hover")
    checks.push("mouse hover on source opens a native popup with the matching translation")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /2 段译文/ }).click()
    await page.getByText("源语言与目标语言", { exact: true }).waitFor()
    await capture("actions")
    await page.getByText("源语言与目标语言", { exact: true }).click()
    await page.getByText("目标语言", { exact: true }).click()
    const input = page.getByRole("textbox", { name: "目标语言", exact: true })
    await input.fill("ja")
    await input.press("Enter")
    await waitFor(async () => (await (await fetch(origin + "/state")).json()).requests.at(-1)?.target === "ja", "Language controls did not change the real HTTP request.")
    checks.push("status bar actions remain available without an editor title actions button and language input changes actual HTTP targets")
    await page.getByRole("button", { name: /2 段译文/ }).waitFor()
    await attachment(page, "阅读原始文档。")
    const sourceRequests = (await (await fetch(origin + "/state")).json()).requests
    const requestsBeforeStop = sourceRequests.length
    const previewFingerprint = sourceRequests.at(-1)?.inputFingerprint
    const secondSource = page.locator(".view-lines .view-line").filter({ hasText: "Keep" })
    const translatedGlyph = await sourceGlyph(secondSource, "Keep")
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).waitFor()
    await waitFor(async () => !(await attachments(page)).some((value) => value.text.includes("阅读原始文档")), "Browse stop left a decoration behind.")
    await firstSource.waitFor()
    const originalGlyph = await sourceGlyph(secondSource, "Keep")
    assert.ok(
      Math.abs(translatedGlyph.x - originalGlyph.x) < 0.1 && Math.abs(translatedGlyph.width - originalGlyph.width) < 0.1,
      "Browse changed original text indentation: " + JSON.stringify({ translatedGlyph, originalGlyph })
    )
    checks.push("browse decorations preserve the original source glyph position and width without leading whitespace")
    const afterStopBox = await firstSource.boundingBox()
    await firstSource.hover({ position: { x: 90, y: afterStopBox.height / 2 } })
    await hover.waitFor()
    assert.ok((await hover.innerText()).includes("阅读原始文档"), "Independent hover stopped with immersive browse.")
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, requestsBeforeStop, "Independent hover discarded the browse cache.")
    checks.push("browse stop removes decorations while independent hover reuses the shared cache")
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await attachment(page, "阅读原始文档。")
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, requestsBeforeStop, "Browse buttons discarded cached translations.")
    checks.push("document toggle restores cached browsing without another translation request")
    await firstSource.click({ button: "right" })
    await page.getByRole("menuitem", { name: "注释翻译+", exact: true }).hover()
    const diagnostics = page.getByRole("menuitem", { name: "查看翻译状态与错误", exact: true })
    // VS Code arms new submenu mouse-up handlers after 100 ms to ignore the opening gesture.
    await diagnostics.click({ delay: 150 })
    const logStatus = page.getByText(/任务完成/).last()
    await logStatus.waitFor()
    await logStatus.click()
    await page.keyboard.press("Control+Home")
    await page
      .getByText(/任务开始：2/)
      .first()
      .waitFor()
    await page.keyboard.press("Control+f")
    const logFind = page.getByRole("textbox", { name: "Find", exact: true })
    const defaults = manifest.contributes.configuration.properties["commentTranslatePlus.profiles"].items.properties
    const systemLead = defaults.systemPrompt.default.split("\n", 1)[0].replace("${targetLang}", defaults.languageNames.default["zh-CN"])
    await logFind.fill(systemLead)
    await page.keyboard.press("Escape")
    await page.locator(".view-lines .view-line").filter({ hasText: systemLead }).first().waitFor()
    await capture("logs")
    checks.push("editor context menu opens accumulated request diagnostics with the complete rendered system prompt")
    await page.keyboard.press("Control+j")
    await page.getByRole("treeitem", { name: "examples", exact: true }).click()
    await page.getByRole("treeitem", { name: "development", exact: true }).click()
    await page.getByRole("treeitem", { name: "nested-frontmatter.md", exact: true }).dblclick()
    await page.getByRole("tab", { name: /^nested-frontmatter.md/ }).waitFor()
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await attachment(page, "描述:")
    const fieldTranslation = await attachment(page, "描述:")
    assert.ok(!fieldTranslation.text.includes("|"), "YAML block scalar indicator leaked into the browse translation.")
    const fieldEnd = await page.locator(".view-lines .view-line").filter({ hasText: "Keep both lines together." }).boundingBox()
    const nextField = await page
      .locator(".view-lines .view-line")
      .filter({ hasText: /^metadata:/ })
      .boundingBox()
    assert.ok(
      fieldEnd && nextField && fieldEnd.y + fieldEnd.height <= fieldTranslation.y && fieldTranslation.y + fieldTranslation.height <= nextField.y,
      "Multiline YAML translation overlaps or splits its original field."
    )
    checks.push("multiline YAML translation includes its translated key without block indicators and follows the complete original field")
    const fieldLine = page.locator(".view-lines .view-line").filter({ hasText: "Read the complete field." })
    const fieldBox = await fieldLine.boundingBox()
    assert.ok(fieldBox)
    await fieldLine.hover({ position: { x: 100, y: fieldBox.height / 2 } })
    const fieldHover = page.locator(".monaco-hover").filter({ hasText: "注释翻译+" })
    await fieldHover.waitFor()
    const fieldText = (await fieldHover.innerText()).replace(/\u00a0/g, " ")
    assert.ok(
      fieldText.includes("阅读完整字段") && fieldText.includes("保留两行在一起") && !fieldText.includes("|"),
      "Multiline YAML value hover lost part of its complete scalar or retained block syntax."
    )
    await capture("frontmatter-hover")
    checks.push("sample workspace supports opening nested YAML and hovering its complete multiline translation")
    await page.keyboard.press("Escape")
    const beforeModes = (await (await fetch(origin + "/state")).json()).requests.length
    await toggleMode(page)
    await waitFor(async () => (await page.locator(".codelens-decoration").count()) === 0, "Inplace mode retained placeholder rows.")
    await attachment(page, "描述:")
    await waitFor(async () => !(await fieldLine.innerText()).replace(/\u00a0/g, " ").includes("Read the complete field."), "Inplace mode did not hide the original field.")
    await capture("inplace")
    await page.keyboard.press("Control+g")
    const lineInput = page.locator(".quick-input-widget input")
    await lineInput.fill(":4:5")
    await lineInput.press("Enter")
    await waitFor(
      async () => (await fieldLine.innerText()).replace(/\u00a0/g, " ").includes("Read the complete field."),
      "Moving the cursor into the field did not restore original source."
    )
    const editingBox = await fieldLine.boundingBox()
    await fieldLine.click({ position: { x: 100, y: editingBox.height / 2 } })
    await page.getByRole("button", { name: /^Ln 4, Col / }).waitFor()
    assert.ok((await fieldLine.innerText()).replace(/\u00a0/g, " ").includes("Read the complete field."), "Source was hidden again after placing the edit cursor.")
    await capture("inplace-editing")
    checks.push("inplace mode reveals the complete field when the cursor enters it without an edit-source command")
    await toggleMode(page)
    await attachment(page, "描述:")
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, beforeModes, "Display mode changes discarded translation cache.")
    checks.push("status bar menu switches display modes without a title button or another translation request")
    await page.getByRole("button", { name: "打开 Markdown 翻译预览", exact: true }).click()
    let preview
    await waitFor(async () => {
      for (const frame of page.frames()) {
        try {
          if ((await frame.locator("body.vscode-body").count()) && (await frame.locator("body").innerText()).includes("保留")) {
            preview = frame
            return true
          }
        } catch {
          /* The native Markdown preview replaces its frame while loading. */
        }
      }
      return false
    }, "Native Markdown preview did not render translated prose.")
    const previewText = await preview.locator("body").innerText()
    assert.ok(
      previewText.includes("描述") && previewText.includes("阅读完整字段") && previewText.includes("保留两行在一起"),
      "Native preview lost the translated key or part of its complete value."
    )
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, beforeModes, "Preview did not reuse browse cache.")
    await capture("preview")
    checks.push("locked native Markdown preview renders translated prose beside the source and reuses browse cache")
    await page.getByRole("tab", { name: /^local-browse.md/ }).click()
    assert.ok((await preview.locator("body").innerText()).includes("Nested frontmatter"), "Locked preview followed a different active source.")
    await page.getByRole("button", { name: "打开 Markdown 翻译预览", exact: true }).click()
    await waitFor(async () => {
      for (const frame of page.frames()) {
        try {
          if ((await frame.locator("body.vscode-body").count()) && (await frame.locator("body").innerText()).includes("阅读原始文档")) {
            preview = frame
            return true
          }
        } catch {
          /* Native preview navigation may replace the frame. */
        }
      }
      return false
    }, "Native Markdown preview did not render the requested second document.")
    assert.ok((await preview.locator("code").innerText()).includes("sourceId"), "Native preview lost protected inline code.")
    await waitFor(
      async () => await preview.locator("img").evaluateAll((images) => images.some((image) => image.complete && image.naturalWidth === 24)),
      "Relative image did not load through the preview filesystem."
    )
    await capture("preview-resources")
    checks.push("locked preview stays on its source; another preview preserves inline code and loads a relative image")
    const beforePreviewRefresh = (await (await fetch(origin + "/state")).json()).requests
    await control(true)
    try {
      await page.getByRole("button", { name: "重新翻译", exact: true }).click()
      await waitFor(async () => (await (await fetch(origin + "/state")).json()).requests.length > beforePreviewRefresh.length, "Preview refresh icon did not issue a fresh request.")
      const refreshedRequests = (await (await fetch(origin + "/state")).json()).requests.slice(beforePreviewRefresh.length)
      assert.ok(
        previewFingerprint && refreshedRequests.length === 1 && refreshedRequests[0].inputFingerprint === previewFingerprint,
        "Preview icon refreshed another document or duplicated a request: " + JSON.stringify({ expected: previewFingerprint, refreshedRequests })
      )
      await preview.getByRole("progressbar").first().waitFor()
      await capture("preview-retranslate-loading")
    } finally {
      await control(false)
    }
    await waitFor(
      async () => (await preview.getByRole("progressbar").count()) === 0 && (await preview.locator("body").innerText()).includes("阅读原始文档"),
      "Preview refresh did not finish rendering translation."
    )
    await capture("preview-retranslated")
    checks.push("translated Markdown preview refresh icon sends a fresh source request, shows inline loading and restores the translated preview")
    await page.getByRole("treeitem", { name: "below-wrapped.md", exact: true }).dblclick()
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await page.keyboard.press("Control+End")
    await page.getByRole("button", { name: /1 段译文/ }).waitFor()
    const wrappedEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "EndOfWrappedSource." }) })
    await wrappedEditor.hover()
    await page.mouse.wheel(0, 10000)
    await waitFor(async () => {
      const wrappedTranslation = await attachment(page, "EndOfWrappedSource.")
      const lastWrappedRow = await wrappedEditor.locator(".view-lines .view-line").filter({ hasText: "EndOfWrappedSource." }).boundingBox()
      const editorBox = await wrappedEditor.boundingBox()
      return (
        lastWrappedRow &&
        editorBox &&
        lastWrappedRow.y + lastWrappedRow.height <= wrappedTranslation.y &&
        wrappedTranslation.y + wrappedTranslation.height <= editorBox.y + editorBox.height
      )
    }, "Final translation is not visible below the final soft-wrapped source row.")
    await capture("below-wrapped")
    checks.push("translation follows the last visual row of a soft-wrapped paragraph at the end of a scrollable document")
    await page.getByRole("treeitem", { name: "unchanged-browse.md", exact: true }).dblclick()
    const unchangedEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "AcmeSDK keeps its original product name." }) })
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await page.getByRole("button", { name: /1 段译文 · 1 段保留原文/ }).waitFor()
    await attachment(unchangedEditor, "阅读原始文档。")
    assert.ok(!(await attachments(unchangedEditor)).some((item) => item.text.includes("AcmeSDK")), "An unchanged unit painted a duplicate translation.")
    assert.equal(await unchangedEditor.locator(".codelens-decoration").count(), 0, "An unchanged first paragraph left a blank translation row.")
    assert.equal((await loadingIcons(unchangedEditor)).length, 0, "An unchanged result retained its loading icon.")
    const preserved = unchangedEditor.locator(".view-lines .view-line").filter({ hasText: "AcmeSDK keeps its original product name." })
    await toggleMode(page)
    await waitFor(
      async () => !(await unchangedEditor.locator(".view-lines").innerText()).replace(/\u00a0/g, " ").includes("Read the original document."),
      "Inplace mode did not replace the changed source paragraph."
    )
    assert.ok((await preserved.innerText()).replace(/\u00a0/g, " ").includes("AcmeSDK keeps its original product name."), "Inplace mode hid an untranslated source unit.")
    await attachment(unchangedEditor, "阅读原始文档。")
    await capture("unchanged")
    await toggleMode(page)
    await waitFor(
      async () => (await unchangedEditor.locator(".view-lines").innerText()).replace(/\u00a0/g, " ").includes("Read the original document."),
      "Contrast mode did not restore the changed source paragraph."
    )
    const cachedUnchanged = (await (await fetch(origin + "/state")).json()).requests.length
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await page.getByRole("button", { name: /1 段译文 · 1 段保留原文/ }).waitFor()
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, cachedUnchanged, "Reopening an unchanged result requested translation again.")
    checks.push("unchanged results create no duplicate or blank row, remain visible in inplace mode, clear loading and reuse cache")
    await page.getByRole("treeitem", { name: "preview-loading.md", exact: true }).dblclick()
    await control(true)
    let loadingPreview
    try {
      await page.getByRole("button", { name: "打开 Markdown 翻译预览", exact: true }).click()
      await waitFor(async () => {
        for (const frame of page.frames()) {
          try {
            if ((await frame.getByRole("progressbar").count()) && (await frame.locator("body").innerText()).includes("Preview loading sample")) {
              loadingPreview = frame
              return true
            }
          } catch {
            /* Native preview navigation replaces its frame. */
          }
        }
        return false
      }, "Pending preview did not display inline loading indicators.")
      const animation = await loadingPreview
        .getByRole("progressbar")
        .first()
        .evaluate(async (element) => {
          const style = getComputedStyle(element)
          const animation = element.getAnimations()[0]
          const before = animation?.currentTime
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          return { width: parseFloat(style.width), height: parseFloat(style.height), name: style.animationName, before, after: animation?.currentTime }
        })
      assert.ok(animation.width > 0 && animation.height > 0 && animation.name !== "none" && animation.after > animation.before, "Preview spinner has no visible running animation.")
      assert.equal(await loadingPreview.getByRole("heading", { name: "Preview loading sample", exact: true }).count(), 1)
      assert.equal(await loadingPreview.getByRole("heading", { name: "Setext title", exact: true }).count(), 1)
      assert.equal(await loadingPreview.locator("table").filter({ hasText: "Description" }).locator("tbody tr").count(), 1, "Loading markup damaged the Markdown table.")
      assert.equal((await loadingPreview.locator("pre code").innerText()).trim(), "const untouched = 1;", "Loading markup entered a code block.")
      assert.ok(!(await loadingPreview.locator("body").innerText()).includes("正在翻译"), "Preview still shows a loading banner.")
      await capture("preview-loading")
    } finally {
      await control(false)
    }
    await waitFor(async () => {
      try {
        return (await loadingPreview.getByRole("progressbar").count()) === 0 && (await loadingPreview.locator("body").innerText()).includes("阅读原始文档")
      } catch {
        return false
      }
    }, "Completed preview retained loading markers or lost translated content.")
    await capture("preview-complete")
    checks.push("native preview shows running inline spinners without a banner, preserves headings/tables/code and removes indicators on completion")
    await page.getByRole("treeitem", { name: "hover-pending.md", exact: true }).dblclick()
    const pendingEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "HoverPendingProbe" }) })
    const pendingLine = pendingEditor.locator(".view-lines .view-line").filter({ hasText: "Read" })
    const pendingBox = await pendingLine.boundingBox()
    const beforePending = (await (await fetch(origin + "/state")).json()).requests.length
    await control(true)
    try {
      await pendingLine.hover({ position: { x: 80, y: pendingBox.height / 2 } })
      await waitFor(async () => (await (await fetch(origin + "/state")).json()).requests.length > beforePending, "Delayed source hover sent no request.")
      for (const x of [90, 110, 130]) {
        await pendingLine.hover({ position: { x, y: pendingBox.height / 2 } })
        await delay(400)
      }
      const pendingRequests = (await (await fetch(origin + "/state")).json()).requests.slice(beforePending)
      assert.ok(pendingRequests.length === 1 && !pendingRequests[0].cancelled, "Moving within the same pending source cancelled/restarted translation: " + JSON.stringify(pendingRequests))
    } finally {
      await control(false)
    }
    await hover.waitFor()
    assert.ok((await hover.innerText()).includes("阅读原始文档"), "Delayed hover failed to show its completed translation.")
    await capture("hover-pending")
    await page.keyboard.press("Escape")
    checks.push("uncached native hover survives mouse movement within the same source, sends one request and displays the completed translation")
    await page.getByRole("treeitem", { name: "scalars-and-table.md", exact: true }).dblclick()
    const scalarEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "ScalarTableProbe" }) })
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    await attachment(scalarEditor, "默认启用: true")
    await attachment(scalarEditor, "描述: 阅读完整字段。 保留两行在一起。")
    const tableRow = await attachment(scalarEditor, "| 阅读原始文档。 | 保留 text. |")
    assert.equal(tableRow.text.split("|").length - 1, 3, "Table display added or removed a source delimiter.")
    assert.ok(!tableRow.text.includes(" · "), "Table cells still use middle dots.")
    await capture("scalar-table")
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    checks.push("YAML scalar parts display as complete fields with native values and table rows retain their original pipes")
    await page.getByRole("treeitem", { name: "yaml-fields.yaml", exact: true }).dblclick()
    const yamlEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "data-analysis" }) })
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    const yamlRows = []
    for (const text of ["名称: 数据分析", "元数据:", "可用性: 可用的", "默认启用: true", "只读: false", "必需: false"]) yamlRows.push(await attachment(yamlEditor, text))
    assert.ok(
      yamlRows.every((row) => !row.text.includes(" · ")),
      "YAML fields used middle dots instead of their original colons."
    )
    assert.ok(
      yamlRows.slice(2).every((row) => row.x > yamlRows[1].x),
      "Nested YAML translation rows lost their indentation."
    )
    await capture("yaml-fields")
    await toggleMode(page)
    for (const text of ["名称: 数据分析", "元数据:", "默认启用: true", "只读: false"]) await attachment(yamlEditor, text)
    await capture("yaml-fields-inplace")
    await toggleMode(page)
    await page.getByRole("button", { name: "切换当前文档注释浏览模式", exact: true }).click()
    checks.push("nested YAML contrast and inplace rows visibly retain colons, boolean values and source indentation")
    await page.getByRole("treeitem", { name: "protected-content.md", exact: true }).dblclick()
    const protectedEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "ProtectedContentProbe" }) })
    for (const [source, translated] of [
      ["members", "当设置 `supersedes` 时，必须提供 `members`。"],
      ["**B", "**B — 行业/竞争分析。** 确认范围"]
    ]) {
      const line = protectedEditor.locator(".view-lines .view-line").filter({ hasText: source }).first()
      const box = await line.boundingBox()
      await line.hover({ position: { x: 40, y: box.height / 2 } })
      await hover.waitFor()
      await waitFor(async () => (await hover.innerText()).replace(/\u00a0/g, " ").includes(translated), "Protected hover lost reordered code or its paired formatting boundary.")
      await capture(source === "members" ? "protected-code" : "protected-formatting")
      await page.keyboard.press("Escape")
    }
    checks.push("native hover displays locally restored reordered code and valid paired formatting around Chinese punctuation")
    await page.getByRole("treeitem", { name: "hover replacement (中文 %25).md", exact: true }).dblclick()
    const replacementSource = "You are a professional ${targetLang} translator. Translate each source item accurately and fluently. HoverReplaceProbe %20 %2520 %3A %E4%B8%AD"
    const replacementTranslation = "您是专业的${targetLang}翻译员。请准确流畅地翻译每个源项。 HoverReplaceProbe %20 %2520 %3A %E4%B8%AD"
    const replacementEditor = page.locator(".monaco-editor").filter({ has: page.locator(".view-lines").filter({ hasText: "HoverReplaceProbe" }) })
    const replacementText = async () => (await replacementEditor.locator(".view-lines .view-line").allTextContents()).join("").replace(/\u00a0/g, " ")
    const replacementLine = replacementEditor.locator(".view-lines .view-line").filter({ hasText: "You are a professional" })
    const replacementBox = await replacementLine.boundingBox()
    await replacementLine.hover({ position: { x: 80, y: replacementBox.height / 2 } })
    await hover.waitFor()
    assert.ok((await hover.innerText()).includes("您是专业的${targetLang}翻译员"), "Source hover lost its translated code block or literal placeholder.")
    assert.equal(await hover.getByRole("link").count(), 1, "Source hover exposes unrelated actions.")
    await capture("hover-replace")
    const beforeReplace = (await (await fetch(origin + "/state")).json()).requests.length
    await hover.getByRole("link").click()
    await waitFor(async () => (await replacementText()) === replacementTranslation, "Clicking the hover replacement did not edit the captured source paragraph.")
    assert.equal((await (await fetch(origin + "/state")).json()).requests.length, beforeReplace, "Hover replace sent another translation request.")
    await capture("hover-replaced")
    await replacementEditor.locator(".view-lines .view-line").filter({ hasText: "您是专业的" }).click()
    await page.keyboard.press("Control+z")
    await waitFor(async () => (await replacementText()) === replacementSource, "Native undo did not restore the hover replacement.")
    checks.push("source hover command link preserves encoded paths and literal percent escapes, replaces without HTTP and supports native undo")
    const beforeCommand = (await (await fetch(origin + "/state")).json()).requests.length
    await page.keyboard.press("Control+Home")
    await page.keyboard.press("Control+Shift+p")
    const commandInput = page.locator(".quick-input-widget input")
    await commandInput.fill(">Comment Translate Plus: 翻译并替换")
    await commandInput.press("Enter")
    await waitFor(async () => (await replacementText()) === replacementTranslation, "Command palette translation did not replace its cursor unit.")
    const afterCommand = (await (await fetch(origin + "/state")).json()).requests.length
    assert.ok(afterCommand <= beforeCommand + 1, "One cursor unit triggered repeated translation requests.")
    await capture("translate-and-replace")
    await replacementEditor.locator(".view-lines .view-line").filter({ hasText: "您是专业的" }).click()
    await page.keyboard.press("Control+z")
    await waitFor(async () => (await replacementText()) === replacementSource, "Native undo did not restore the command replacement.")
    checks.push("English command category exposes translate-and-replace in the native command palette and cursor replacement supports undo")
    await page.keyboard.press("Control+Shift+p")
    await commandInput.fill(">Markdown: Open Preview")
    await commandInput.press("Enter")
    await waitFor(async () => {
      for (const frame of page.frames()) {
        try {
          if ((await frame.locator("body.vscode-body").count()) && (await frame.locator("body").innerText()).includes("You are a professional")) return true
        } catch {
          /* The native preview is still opening. */
        }
      }
      return false
    }, "Ordinary Markdown preview did not render its original source.")
    assert.equal(
      await page.locator(".editor-group-container.active").getByRole("button", { name: "重新翻译", exact: true }).count(),
      0,
      "Ordinary Markdown preview exposes a translation refresh icon."
    )
    await capture("ordinary-preview")
    checks.push("ordinary Markdown preview keeps its original content and exposes no translation refresh icon")
    console.log(`Official Web UI: ${checks.length} checks passed; screenshots in artifacts/ui/.`)
    return {
      host: "vscode-test-web",
      mode: packaged ? "package" : "development",
      checks,
      screenshots,
      viewport: page.viewportSize(),
      layout: { firstTranslation, firstSource: firstSourceBox, secondTranslation, secondSource: secondSourceBox, sourceIndentation: { translatedGlyph, originalGlyph } },
      visualLayoutVerified: true,
      liveTranslationVerified: false,
      scope: "Markdown layout, native hover, cached controls, inplace editing, diagnostics, nested YAML and native translated preview"
    }
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: `artifacts/ui/${packaged ? "package-" : ""}failure.png` })
    throw error
  } finally {
    await browser.close()
  }
}
