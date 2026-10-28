import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createPortProbe } from "node:net"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { pipeline } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import { spawn, spawnSync } from "node:child_process"
import yauzl from "yauzl"
import { localServiceFromEnvironment } from "./local-service.mjs"
import manifest from "../package.json" with { type: "json" }

const languageCodes = new Map(
  Object.entries(manifest.contributes.configuration.properties["commentTranslatePlus.profiles"].items.properties.languageNames.default).map(([code, name]) => [name, code])
)

const flags = new Set(process.argv.slice(2))
assert.ok(
  flags.size === process.argv.length - 2 && [...flags].every((flag) => ["--package", "--local", "--interactive", "--ui"].includes(flag)),
  "usage: node tools/test-desktop.mjs [--package] [--local] [--interactive | --ui]"
)
const packaged = flags.has("--package")
const interactive = flags.has("--interactive")
const ui = flags.has("--ui")
assert.ok(!(interactive && ui), "--interactive and --ui must run separately")
assert.ok(!(ui && flags.has("--local")), "--ui uses deterministic HTTP responses; use --local separately for real-service checks")
const local = flags.has("--local") ? await localServiceFromEnvironment() : undefined
const runner = local ? "local.cjs" : "index.cjs"
await mkdir(".vscode-test", { recursive: true })
const runDirectory = await mkdtemp(resolve(".vscode-test", packaged ? "desktop-package-" : "desktop-development-"))
let extensionRoot = resolve(".")

if (packaged) {
  extensionRoot = resolve(runDirectory, "extension")
  await new Promise((done, fail) =>
    yauzl.open("artifacts/comment-translate-plus.vsix", { lazyEntries: true }, (error, zip) => {
      if (error) {
        fail(error)
        return
      }
      zip.on("error", fail)
      zip.on("end", done)
      zip.on("entry", (entry) => {
        void (async () => {
          if (!entry.fileName.startsWith("extension/")) {
            zip.readEntry()
            return
          }
          const path = resolve(extensionRoot, entry.fileName.slice("extension/".length))
          const local = relative(extensionRoot, path)
          assert.ok(!isAbsolute(local) && local !== ".." && !local.startsWith("..\\") && !local.startsWith("../"), "invalid VSIX entry path")
          if (entry.fileName.endsWith("/")) await mkdir(path, { recursive: true })
          else {
            await mkdir(dirname(path), { recursive: true })
            const stream = await new Promise((accept, reject) => zip.openReadStream(entry, (error, value) => (error ? reject(error) : accept(value))))
            await pipeline(stream, createWriteStream(path))
          }
          zip.readEntry()
        })().catch((error) => {
          zip.close()
          fail(error)
        })
      })
      zip.readEntry()
    })
  )
  // Only the test runner is injected; the product entry remains the exact VSIX bytes.
  await mkdir(resolve(extensionRoot, "test"), { recursive: true })
  await copyFile(resolve("artifacts/extension-tests", runner), resolve(extensionRoot, "test/index.cjs"))
}

let broken = false
let leakDiagnostics = false
let damageCode = false
let damageLink = false
let referenceContamination = false
let slow = false
let hold = false
let termFile = '["Widget"]'
let termFileReads = 0
const heldResponses = new Set()
let report
const requests = []

function dropLastProtection(text) {
  const marker = text.match(/<CTP(?:\d+_)?\d+>/g)?.at(-1) ?? text.match(/`[^`]+`|https?:\/\/[^\s)]+/g)?.at(-1)
  assert.ok(marker, "The fault fixture contains no protected placeholder.")
  return text.replace(marker, "")
}

const translatedText = (text) =>
  text
    .replace(/^Open the sample sheet at (<CTP(?:\d+_)?\d+>)\.$/u, "打开示例表格 $1。")
    .replaceAll("example_catalog_snapshot", "示例目录快照")
    .replace("This is a sample museum catalog prepared for the spring exhibition.", "这是为春季展览准备的示例博物馆目录。")
    .replace(/^Read task\/context fields\.$/u, "- 读取任务/上下文字段。")
    .replace(/^Read input\/output fields\.$/u, "1. 读取输入/输出字段。")
    .replace(/(`pages`) is required when (`edition`) is set\./, "当设置 $2 时，必须提供 $1。")
    .replace("C — Books / Journals.", " \tC — 图书/期刊。\t ")
    .replace("Confirm scope across", "确认范围，按")
    .replace("Reading categories", " 阅读分类 ")
    .replace(
      /You are a professional (<CTP(?:\d+_)?\d+>|\$\{[^{}\r\n]+\}) translator\. Translate each source item accurately and fluently\./,
      "您是专业的$1翻译员。请准确流畅地翻译每个源项。"
    )
    .replace("Read the complete field.", "阅读完整字段。")
    .replace("Keep both lines together.", "保留两行在一起。")
    .replace("Keep its context.", "保留其上下文。")
    .replace("Read the original document.", "阅读原始文档。")
    .replace("Widget project.lock", "控件与项目锁")
    .replace("Keep ", "保留 ")
    .replace(" and ", " 和 ")
    .replace(/^(\s*)data-analysis(\s*)$/, "$1数据分析$2")
    .replace(/^(\s*)active(\s*)$/, "$1可用的$2")
    .replace(
      /^(\s*(?:-\s+)?)(description|name|notes|metadata|label|hints|enabled|priority|count|meta|tags|default_enabled|availability|read_only|required)(?=\s*:|\s*$)/gm,
      (_match, prefix, key) =>
        prefix +
        {
          description: "描述",
          name: "名称",
          notes: "备注",
          metadata: "元数据",
          label: "标签",
          hints: "提示",
          enabled: "启用",
          priority: "优先级",
          count: "数量",
          meta: "元信息",
          tags: "标签",
          default_enabled: "默认启用",
          availability: "可用性",
          read_only: "只读",
          required: "必需"
        }[key]
    )
const mock = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*")
  response.setHeader("Access-Control-Allow-Credentials", "true")
  response.setHeader("Vary", "Origin")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  response.setHeader("Access-Control-Allow-Private-Network", "true")
  response.setHeader("Content-Type", "application/json")
  if (request.method === "OPTIONS") {
    response.writeHead(204).end()
    return
  }
  if ((local || ui) && request.url === "/credentials") {
    response.end(JSON.stringify({ apiKey: local?.apiKey ?? "mock-test" }))
    return
  }
  if (request.url === "/state") {
    response.end(JSON.stringify({ requests, termFileReads }))
    return
  }
  const url = new URL(request.url, "http://localhost")
  if (url.pathname === "/preserve-terms.json") {
    termFileReads++
    if (termFile === null) response.writeHead(503).end("unavailable")
    else response.end(termFile)
    return
  }
  if (url.pathname === "/google") {
    requests.push({ started: performance.now(), provider: "google", source: url.searchParams.get("sl"), target: url.searchParams.get("tl"), count: 1, authenticated: false })
    response.end(JSON.stringify([[[translatedText(url.searchParams.get("q"))]]]))
    return
  }
  if (url.pathname === "/bing/translator") {
    response.end('IG:"probe" data-iid="translator.1" params_AbusePreventionHelper = [123456,"fixture-token",600000];')
    return
  }
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString("utf8")
    if (url.pathname === "/bing/ttranslatev3") {
      const form = new URLSearchParams(raw)
      requests.push({ started: performance.now(), provider: "bing", source: form.get("fromLang"), target: form.get("to"), count: 1, authenticated: false })
      response.end(JSON.stringify([{ translations: [{ text: translatedText(form.get("text")), to: form.get("to") }] }]))
      return
    }
    const body = JSON.parse(raw)
    if (request.url === "/control") {
      if ("termFile" in body) termFile = body.termFile
      if ("broken" in body) broken = body.broken
      if ("leakDiagnostics" in body) leakDiagnostics = body.leakDiagnostics
      if ("damageCode" in body) damageCode = body.damageCode
      if ("damageLink" in body) damageLink = body.damageLink
      if ("referenceContamination" in body) referenceContamination = body.referenceContamination
      if ("slow" in body) slow = body.slow
      if ("hold" in body) {
        hold = body.hold
        if (!hold) {
          for (const release of heldResponses) release()
          heldResponses.clear()
        }
      }
      response.end("{}")
    } else if (request.url === "/report") {
      report = body
      response.end("{}")
    } else if (request.url === "/v1/chat/completions" || request.url === "/public/v1/chat/completions") {
      if (request.url.startsWith("/public/") ? request.headers.authorization !== undefined : request.headers.authorization !== "Bearer mock-test") {
        response.writeHead(401).end("{}")
        return
      }
      if (body.response_format !== undefined) {
        response.writeHead(400).end("{}")
        return
      }
      const system = body.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n")
      const users = body.messages.filter((message) => message.role === "user")
      const user = users[0]?.content ?? ""
      const custom = user.match(/\[\[custom-source\]\]\n([\s\S]*)\n\[\[\/custom-source\]\]/)
      const current = users.at(-1)?.content ?? ""
      const instruction = /(?:^|\r?\n)(?:Based on the error response, re-translate|Translate) (?:the following text into|to) ([^\r\n]+):\r?\n\r?\n/.exec(current)
      const text = instruction ? current.slice(instruction.index + instruction[0].length) : custom ? custom[1] : current
      const feedback = users.length === 2 && instruction ? current.slice(0, instruction.index) : ""
      const feedbackLines = feedback.split("\n")
      const context = [system, user].join("\n").match(/<(?:context|reference)>\n([\s\S]*?)\n<\/(?:context|reference)>/)?.[1] ?? ""
      const separator = system.match(/Separate their translations with (\S+) on its own line/)?.[1] ?? "%%"
      const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const pieces = text.split(new RegExp("\\r?\\n[ \\t]*" + escaped + "[ \\t]*\\r?\\n"))
      const record = {
        started: performance.now(),
        provider: "openai",
        model: body.model,
        target:
          user.match(/^Target language: [^\n]*?\[([^\]]+)\]/)?.[1] ?? system.match(/Target language: [^\n]*?\[([^\]]+)\]/)?.[1] ?? languageCodes.get(instruction?.[1]) ?? instruction?.[1],
        source: system.match(/Source language: [^\n]*?\[([^\]]+)\]/)?.[1],
        sourceDeclared: system.includes("Source language:"),
        referenceIncluded: !!context,
        retryFeedbackIncluded: users.length === 2 && body.messages.at(-1) === users[1] && feedback.startsWith("Previous response errors:"),
        retryFeedbackCompact: users.length === 2 && !/Item \d|Current request:|\b(?:translation|service)-[a-z-]+/.test(feedback),
        retryFeedbackEnglishSeparated:
          users.length === 2 &&
          feedback
            .trim()
            .split("\n\n")
            .filter((block) => !block.startsWith("Current request:"))
            .every((block) => {
              const lines = block.split("\n")
              return lines.length === 2 && lines[0].startsWith("Previous response errors: ") && lines[1].startsWith("Correction: ")
            }),
        previousOutputFingerprint: body.messages.some((message) => message.role === "assistant")
          ? createHash("sha256")
              .update(body.messages.find((message) => message.role === "assistant").content)
              .digest("hex")
          : undefined,
        numberedCorrections:
          users.length === 2 &&
          feedbackLines.some(
            (line, index) =>
              line.startsWith("Previous response errors: Item 1:") &&
              line.includes("exactly once") &&
              feedbackLines[index + 1]?.startsWith("Correction: Item 1:") &&
              feedbackLines[index + 1].includes("marker")
          ) &&
          feedbackLines.some(
            (line, index) =>
              line.startsWith("Previous response errors: Item 2:") &&
              line.includes("empty") &&
              feedbackLines[index + 1]?.startsWith("Correction: Item 2:") &&
              feedbackLines[index + 1].includes("non-empty")
          ),
        contextCharacters: context.length,
        contextFingerprint: createHash("sha256").update(context).digest("hex"),
        inputCharacters: body.messages.reduce((sum, message) => sum + message.content.length, 0),
        messageFingerprint: createHash("sha256").update(JSON.stringify(body.messages)).digest("hex"),
        inputFingerprint: createHash("sha256").update(text).digest("hex"),
        itemFingerprints: pieces.map((item) => createHash("sha256").update(item.trim()).digest("hex")),
        count: pieces.length,
        authenticated: !!request.headers.authorization,
        customPrompts: !!custom && body.messages.length === 1 && body.messages[0].role === "user",
        customLanguage: !!custom && user.includes("自定义中文名称"),
        cancelled: false
      }
      requests.push(record)
      if (
        body.model === "transport-retry-fixture" &&
        text.includes("TransportRetryCase.") &&
        requests.filter((item) => item.model === body.model && item.inputFingerprint === record.inputFingerprint).length === 1
      ) {
        request.socket.destroy()
        return
      }
      response.on("close", () => {
        record.cancelled = !response.writableEnded
      })
      const translations = pieces
        .map((text) =>
          body.model === "language-review-fixture" && text.includes("Review scenario:")
            ? record.retryFeedbackIncluded
              ? "优先选择北门附近安静的阅览室。游客可以在服务台借阅纸质地图，并在离开前归还。"
              : text
            : body.model === "language-rewrite-fixture" && text.includes("Review scenario:")
              ? text.replace("Prefer", "Use")
              : body.model === "language-recovery-fixture" && text.includes("Review scenario:")
                ? requests.filter((item) => item.model === body.model && item.inputFingerprint === record.inputFingerprint).length < 3
                  ? text.replace("Prefer", "Use")
                  : "优先选择北门附近安静的阅览室。游客可以在服务台借阅纸质地图，并在离开前归还。"
                : body.model === "language-choice-fixture" && text.includes("Review scenario:")
                  ? text
                  : body.model === "unchanged-fixture"
                    ? ["label", "AcmeSDK"].includes(text.trim())
                      ? text.trim()
                      : "\r\n" + text.replaceAll("original document", "originaldocument").replaceAll(" ", "\t  ") + "\r\n"
                    : translatedText(damageCode && text.includes("Keep ") ? text + "\n\nExtra paragraph." : text)
        )
        .map((text) => (damageLink && text.includes("code-only-no-request") ? dropLastProtection(text) : text))
        .map((text, index) =>
          pieces[index].includes("Reference contamination case.") && (referenceContamination === "always" || (referenceContamination === "once" && !record.retryFeedbackIncluded))
            ? "<context>\n## 参考内容\n\n查看示例陶器清单时调用 `sample_task`。\n</context>"
            : text
        )
      if (broken) translations.pop()
      if (hold) await new Promise((resolve) => heldResponses.add(resolve))
      if (slow) await delay(150)
      let content = leakDiagnostics ? (users.length === 1 ? "" : 'Item 1: translation-item-invalid reason: "模型将错误诊断翻译为正文。"') : translations.join("\n" + separator + "\n")
      if (body.model === "log-recovery-fixture") {
        if (text === "Sources")
          content =
            requests.filter((item) => item.model === body.model && item.inputFingerprint === record.inputFingerprint).length === 1
              ? "用于理解的上下文：\n<context>\n## 博物馆游客指南\n</context>"
              : "来源"
        else if (text.startsWith("**Reading room closes")) content = "** 阅览室于黄昏关闭。  \r\n** 请将借阅的地图归还服务台。"
        else if (text === "The village library has **illustrated** travel guides.") content = "乡村图书馆提供带插图的旅行指南。"
        else if (text === "A shelf label `catalog.txt` is **recommended**.") content = "建议提供书架标签 `catalog.txt`。"
        else if (text === "The village library has *illustrated* travel guides.") content = "乡村图书馆提供带插图的旅行指南。"
        else if (text === "A shelf label `catalog.txt` is _recommended_.") content = "建议提供书架标签 `catalog.txt`。"
        else if (text.startsWith("The `Example reading room:`")) content = "`Example reading room:` 标签指向花园旁的北侧画廊。"
      }
      if (text === "Read `sourceId` unchanged. InlineCodeToleranceCase.") content = "阅读 sourceChanged，并标记 `body/html`。"
      if (body.model === "retry-history-fixture" && text.includes("JointRetryHistoryCase.") && !record.retryFeedbackIncluded) content = "第一项丢失了代码。\n%%\n"
      if (body.model === "request-echo-fixture" && text.includes("RequestEchoCase") && pieces.length > 1) {
        const attempt = requests.filter((item) => item.model === body.model && item.inputFingerprint === record.inputFingerprint).length
        if (attempt === 1) content = "Incomplete answer."
        else if (attempt === 2) content = current
      }
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }))
    } else response.writeHead(404).end("{}")
  } catch {
    response.writeHead(500).end("{}")
  }
})
await new Promise((done) => mock.listen(0, "127.0.0.1", done))
const origin = `http://localhost:${mock.address().port}`
const workspace = resolve(runDirectory, "workspace")
await mkdir(workspace, { recursive: true })
const hostCases = JSON.parse(await readFile("fixtures/development/cases.json", "utf8"))
for (const item of hostCases) {
  const destination = resolve(workspace, "examples", item.file)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(resolve("fixtures", item.file), destination)
}
await writeFile(resolve(workspace, "host-cases.json"), JSON.stringify(hostCases))
await writeFile(
  resolve(workspace, "README.md"),
  "# 注释翻译+ 测试样本\n\n在左侧 examples 中选择文件，然后点击编辑器右上角“切换当前文档注释浏览模式”。只翻译显式开启的文件；关闭、开启同一份内容会复用已校验的内存缓存。“重新翻译”强制请求服务。\n\n模拟服务只验证结构与流程，不代表真实翻译质量；`serve:local` 则直接访问本地真实服务。\n\n" +
    hostCases.map((item) => `- [${item.id}](./examples/${item.file})`).join("\n") +
    "\n"
)
const bundleHash = createHash("sha256")
  .update(await readFile(resolve(extensionRoot, "dist/extension.cjs")))
  .digest("hex")
await writeFile(
  resolve(workspace, "desktop-test.json"),
  JSON.stringify({
    origin,
    mode: packaged ? "package" : "development",
    bundleHash,
    ui,
    serviceSettings:
      local?.settings ??
      (ui || interactive
        ? {
            profiles: [{ id: "test", name: "模拟服务", provider: "openai", apiUrl: origin + "/v1/chat/completions", model: "mock-ui" }],
            activeProfile: "test",
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            logDetails: true,
            maxRequestsPerSecond: 100
          }
        : undefined)
  })
)

let setup
if (local || ui || interactive) {
  setup = resolve(runDirectory, "setup")
  await mkdir(setup, { recursive: true })
  await writeFile(
    resolve(setup, "package.json"),
    JSON.stringify({
      name: "local-browse-setup",
      publisher: "cattle-horse",
      version: "0.0.0",
      engines: { vscode: "^1.140.0" },
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"]
    })
  )
  await writeFile(resolve(setup, "package.nls.json"), "{}\n")
  await copyFile("artifacts/extension-tests/local.cjs", resolve(setup, "index.cjs"))
}
const reportPath = ui
  ? packaged
    ? "artifacts/package-ui-desktop.json"
    : "artifacts/ui-desktop.json"
  : local
    ? packaged
      ? "artifacts/local-service-package-desktop.json"
      : "artifacts/local-service-desktop.json"
    : packaged
      ? "artifacts/package-desktop.json"
      : "artifacts/extension-desktop.json"
try {
  await mkdir(resolve(runDirectory, "user-data/User"), { recursive: true })
  await writeFile(
    resolve(runDirectory, "user-data/User/settings.json"),
    JSON.stringify({ "workbench.startupEditor": "none", "chat.disableAIFeatures": true, "extensions.autoUpdate": false, "update.mode": "none" })
  )
  const executable = await downloadAndUnzipVSCode({ version: "stable" })
  const launchArgs = [
    workspace,
    "--user-data-dir=" + resolve(runDirectory, "user-data"),
    "--extensions-dir=" + resolve(runDirectory, "extensions"),
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-updates",
    "--disable-telemetry"
  ]
  const development = setup ? [extensionRoot, setup] : [extensionRoot]
  if (ui || interactive) {
    const debugProbe = createPortProbe()
    await new Promise((done) => debugProbe.listen(0, "127.0.0.1", done))
    const debugPort = debugProbe.address().port
    await new Promise((done) => debugProbe.close(done))
    const child = spawn(
      executable,
      [...launchArgs, ...development.map((path) => "--extensionDevelopmentPath=" + path), ...(interactive ? ["--inspect-extensions=9229"] : []), "--remote-debugging-port=" + debugPort],
      {
        stdio: "inherit",
        windowsHide: true
      }
    )
    const exited = new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", done)
    })
    try {
      if (ui) {
        const deadline = Date.now() + 60000
        while (true) {
          try {
            if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break
          } catch {
            /* The isolated app is still starting. */
          }
          if (Date.now() > deadline) throw Error("Desktop debug endpoint did not start.")
          await delay(100)
        }
        const { runUiChecks } = await import("./test-ui.mjs")
        const evidence = await runUiChecks({ debugPort, origin, packaged })
        assert.equal(report?.uiKind, 1, "UI checks must run in the desktop host.")
        assert.equal(report?.bundleHash, bundleHash, "UI loaded the wrong bundle.")
        await writeFile(reportPath, JSON.stringify({ ...evidence, vscode: report.vscode, bundleHash, testedExtensionRoot: extensionRoot }, null, 4) + "\n")
      } else {
        console.log("Isolated desktop host ready. Press Ctrl+C to stop.")
        await Promise.race([
          exited,
          new Promise((done) => {
            process.once("SIGINT", done)
            process.once("SIGTERM", done)
          })
        ])
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === "win32") {
          const stopped = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 })
          if (stopped.error) child.kill()
        } else child.kill()
      }
      await exited
    }
  } else {
    await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: false,
      extensionDevelopmentPath: development,
      launchArgs,
      extensionTestsPath: packaged ? resolve(extensionRoot, "test/index.cjs") : resolve("artifacts/extension-tests", runner)
    })
    assert.ok(report?.checks?.length && report.host === "vscode-test-electron", "Desktop tests did not report success.")
    assert.equal(report.bundleHash, bundleHash)
    if (local) assert.equal(report.liveTranslationVerified, true)
    await writeFile(reportPath, JSON.stringify({ ...report, ...(local ? {} : { requests }), testedExtensionRoot: extensionRoot }, null, 4) + "\n")
    console.log(`Official VS Code Desktop: ${report.checks.length} checks passed. Report: ${reportPath}`)
  }
} catch (error) {
  if (!interactive)
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          host: "vscode-test-electron",
          mode: packaged ? "package" : "development",
          status: "failed",
          bundleHash,
          diagnostic: report?.status === "failed" ? report.diagnostic : "host-run-failed",
          checks: [],
          ...(local ? { service: { apiUrl: local.settings.profiles[0].apiUrl, model: local.settings.profiles[0].model } } : {}),
          liveTranslationVerified: false,
          visualLayoutVerified: false,
          testedExtensionRoot: extensionRoot
        },
        null,
        4
      ) + "\n"
    )
  throw error
} finally {
  for (const release of heldResponses) release()
  mock.closeAllConnections()
  await new Promise((done) => mock.close(done))
}
