import * as vscode from "vscode"
import type { Application } from "../../src/host/application.ts"

export async function runTransport(workspace: vscode.Uri, owner: Application, origin: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const settings = {
    profiles: [{ id: "congestion", provider: "openai", apiUrl: origin + "/public/v1/chat/completions", model: "congestion-fixture", apiKey: "" }],
    activeProfile: "congestion",
    skipSameLanguage: false,
    maxConcurrentRequests: 4,
    maxRequestsPerSecond: 100,
    maxTranslationAttempts: 3,
    "requestScheduling.retry": { initialDelayMs: 80, maxDelayMs: 80, jitterRatio: 0 },
    "requestScheduling.recovery": { successes: 1, intervalMs: 20, networkFailureWindowMs: 1000, networkFailureThreshold: 2 }
  }
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, config.inspect(key)?.globalValue]))
  const uri = vscode.Uri.joinPath(workspace, "congestion-scenario.md")
  const disabledUri = vscode.Uri.joinPath(workspace, "congestion-disabled.md")
  const source = "Read the original document. CongestionScenario."
  let document: vscode.TextDocument | undefined
  try {
    for (const [key, value] of Object.entries(settings)) await config.update(key, value, vscode.ConfigurationTarget.Global)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source))
    document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document)
    await owner.browse.start(document)
    const deadline = Date.now() + 10000
    while (owner.browse.inspect(uri)?.status !== "ready") {
      if (owner.browse.inspect(uri)?.status === "error" || Date.now() >= deadline) throw Error("Native congestion recovery did not complete.")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const response = await fetch(origin + "/state")
    const state = (await response.json()) as { requests: { model: string; inputFingerprint: string; started: number; retryFeedbackIncluded: boolean }[] }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
    const fingerprint = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
    const sent = state.requests.filter((item) => item.model === "congestion-fixture" && item.inputFingerprint === fingerprint)
    if (sent.length !== 3 || sent[1].started - sent[0].started < 1000 || sent[2].started - sent[1].started < 80)
      throw Error("Native settings did not preserve Retry-After, backoff or the item attempt budget: " + JSON.stringify(sent))
    if (sent.some((item) => item.retryFeedbackIncluded)) throw Error("Transport retries added model correction instructions.")
    if (document.getText() !== source || document.isDirty || !owner.browse.inspect(uri)?.units[0].translation.includes("阅读原始文档"))
      throw Error("Transport recovery changed source or failed to publish the validated translation.")
    owner.browse.stop(uri, true)
    await config.update("requestScheduling.retry", { http503: false, respectRetryAfter: false, initialDelayMs: 0 }, vscode.ConfigurationTarget.Global)
    const disabledSource = source + " Disabled recovery."
    await vscode.workspace.fs.writeFile(disabledUri, new TextEncoder().encode(disabledSource))
    const disabledDocument = await vscode.workspace.openTextDocument(disabledUri)
    await vscode.window.showTextDocument(disabledDocument)
    await owner.browse.start(disabledDocument)
    const disabledDeadline = Date.now() + 10000
    while (owner.browse.inspect(disabledUri)?.status !== "error") {
      if (Date.now() >= disabledDeadline) throw Error("A nested HTTP 503 retry override was ignored.")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const disabledDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(disabledSource))
    const disabledFingerprint = [...new Uint8Array(disabledDigest)].map((value) => value.toString(16).padStart(2, "0")).join("")
    const disabledState = (await (await fetch(origin + "/state")).json()) as typeof state
    if (
      disabledState.requests.filter((item) => item.model === "congestion-fixture" && item.inputFingerprint === disabledFingerprint).length !== 2 ||
      disabledDocument.getText() !== disabledSource ||
      disabledDocument.isDirty
    )
      throw Error("Partial nested overrides lost the default 429 retry, retried disabled 503, or edited source.")
    return [
      "native grouped scheduling drives HTTP 429 Retry-After and 503 backoff through normal reading, bounded attempts and unchanged source",
      "partial nested native overrides preserve default 429 recovery while disabling Retry-After and 503 retries"
    ]
  } finally {
    owner.browse.stop(uri, true)
    owner.browse.stop(disabledUri, true)
    for (const [key, value] of Object.entries(previous)) await config.update(key, value, vscode.ConfigurationTarget.Global)
  }
}
