import type { TranslationEvent } from "../model/events.ts"
import type { FailedTranslation } from "../model/events.ts"
import { describeError, describeCancellation } from "../model/diagnostics.ts"

export type LogLevel = "info" | "warning" | "error"

export interface TranslationLogContext {
  readonly file: string
  readonly name: string
  readonly model: string
  readonly targetLanguage: string
  readonly apiKey: string
  position(offset: number): string
}

const priority = { info: 0, warning: 1, error: 2 }

function redact(text: string, secrets: readonly string[]): string {
  const tokens = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length)
  for (const secret of tokens) text = text.replaceAll(secret, "[REDACTED]")
  return text
}

function excerpt(value: string, secrets: readonly string[]): string {
  const line = redact(value, secrets).replace(/\s+/g, " ")
  return line.slice(0, 160) + (line.length > 160 ? "…" : "")
}

function failureGroups(failures: readonly FailedTranslation[]): readonly FailedTranslation[][] {
  const groups = new Map<string, FailedTranslation[]>()
  for (const failure of failures) {
    const key = JSON.stringify([failure.code, failure.difference, failure.attempts])
    const group = groups.get(key) ?? []
    group.push(failure)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function modelOutput(raw: string): { text: string; reason?: string; raw: boolean } {
  try {
    const choice = JSON.parse(raw)?.choices?.[0]
    if (typeof choice?.message?.content === "string" && typeof choice.finish_reason === "string") return { text: choice.message.content, reason: choice.finish_reason, raw: false }
  } catch {
    // Invalid protocol data is useful evidence; keep the original response in this case.
  }
  return { text: raw, raw: true }
}

function finishMessage(event: Extract<TranslationEvent, { kind: "finish" }>, context: TranslationLogContext): string {
  const title = { complete: "任务完成", partial: "部分完成", cancelled: "任务已取消", failed: event.completed === event.total ? "请求协议异常" : "翻译失败" }[event.status]
  let message = `${title}：${event.completed}/${event.total} 项，有变化 ${event.changed} 项，无变化 ${event.unchanged} 项，跳过 ${event.skipped} 项，失败 ${event.failures.length} 项，HTTP ${event.httpRequests} 次，${event.elapsedMs} ms`
  if (event.status === "cancelled") return message + "\n  取消原因：" + (event.cancellationReasons ?? ["unspecified"]).map(describeCancellation).join("；")
  if (!event.failures.length) {
    if (event.code) message += "\n  原因：" + describeError(event.code)
    return message
  }
  const secrets = [context.apiKey]
  for (const group of failureGroups(event.failures)) {
    const first = group[0]
    const positions = group
      .slice(0, 5)
      .map((failure) => context.position(failure.start))
      .join("、")
    const remaining = group.length > 5 ? ` 等 ${group.length} 项` : ""
    const attempts = first.attempts ? `已尝试 ${first.attempts} 次` : "尚未请求"
    message += `\n  位置：${positions}${remaining}（${attempts}）`
    if (group.length === 1) message += "\n  原文摘要：" + excerpt(first.source, secrets)
    message += `\n  原因：${first.difference.reason}（${first.code}）`
    if (first.difference.expected !== undefined) message += "\n  期望：" + excerpt(first.difference.expected, secrets)
    if (first.difference.actual !== undefined) message += "\n  返回：" + excerpt(first.difference.actual, secrets)
  }
  message += `\n  已完成结果保留；重试只处理未完成的 ${event.failures.length} 项。`
  return message
}

export class TranslationLog {
  private minimum: LogLevel = "info"
  private details = false
  private readonly systems = new Map<string, string>()
  private systemCharacters = 0
  private systemSequence = 0

  constructor(private readonly output: (entry: string) => void) {}

  configure(value: unknown, details: unknown = false): void {
    if (value !== "info" && value !== "warning" && value !== "error") throw Error("log-level-invalid")
    if (typeof details !== "boolean") throw Error("log-details-invalid")
    if (value !== this.minimum || details !== this.details) this.resetReferences()
    this.minimum = value
    this.details = details
  }

  get detailsEnabled(): boolean {
    return this.details
  }

  enabled(level: LogLevel): boolean {
    return priority[level] >= priority[this.minimum]
  }

  resetReferences(): void {
    this.systems.clear()
    this.systemCharacters = 0
  }

  write(level: LogLevel, message: string, secrets: readonly string[] = []): void {
    if (this.enabled(level)) this.output("[" + new Date().toISOString() + "] [" + level.toUpperCase() + "] " + redact(message, secrets))
  }

  reused(event: { readonly kind: "cache" | "pending"; readonly count: number; readonly total: number }, file: string, apiKey: string): void {
    if (event.kind === "cache" && event.count < event.total)
      this.write("info", file + "：复用缓存 " + event.count + "/" + event.total + " 项，补译 " + (event.total - event.count) + " 项", [apiKey])
  }

  private system(content: string, secrets: readonly string[]): { id: string; definition?: string } {
    const visible = redact(content, secrets)
    const previous = this.systems.get(visible)
    if (previous) {
      this.systems.delete(visible)
      this.systems.set(visible, previous)
      return { id: previous }
    }
    const id = "S" + ++this.systemSequence
    if (visible.length <= 262144) {
      this.systems.set(visible, id)
      this.systemCharacters += visible.length
      while (this.systems.size > 16 || this.systemCharacters > 262144) {
        const oldest = this.systems.keys().next().value!
        this.systems.delete(oldest)
        this.systemCharacters -= oldest.length
      }
    }
    return { id, definition: visible }
  }

  private requestMessage(event: Extract<TranslationEvent, { kind: "request" }>, context: TranslationLogContext, secrets: readonly string[]): string {
    let title = "请求完成"
    if (event.cancelled) title = "请求已取消"
    else if (event.failures.length && event.failures.every((failure) => failure.code === "service-network-failed" || failure.code === "service-timeout")) title = "请求传输失败"
    else if (event.failures.length && event.failures.every((failure) => failure.code === "translation-language-review")) title = "请求语种待复核"
    else if (event.failures.length) title = "请求校验未通过"
    let message = `${title}：${event.completed}/${event.ids.length} 项通过，HTTP ${event.httpRequests} 次，${event.elapsedMs} ms（含排队），尝试 ${event.attempt}`
    if (event.cancelled)
      message += `\n  取消原因：${describeCancellation(event.cancellationReason ?? "unspecified")}；${event.httpRequests ? "HTTP 已开始" : "HTTP 尚未开始（排队或发送前）"}`
    message += `\n  待译 ${event.ids.length} 项，正文 ${event.sourceCharacters} 字符；参考 ${event.contextCharacters} 字符（${event.referenceKinds.join("、") || "无"}）；最终输入 ${event.inputCharacters} 字符；组批：${event.batchReason}`
    if (!event.cancelled && event.failures.length)
      message +=
        "；" +
        [...new Set(event.failures.map((failure) => failure.difference.reason))].join("；") +
        (event.nextBatchSize ? " 以 " + event.nextBatchSize + " 项重试。" : " 未完成项保留原文。")
    if (!event.cancelled)
      for (const group of failureGroups(event.failures)) {
        const first = group[0]
        message +=
          "\n  位置：" +
          group
            .slice(0, 5)
            .map((failure) => context.position(failure.start))
            .join("、") +
          (group.length > 5 ? ` 等 ${group.length} 项` : "")
        message += `\n  差异：${first.difference.reason}（${first.code}）`
        if (first.difference.expected !== undefined) message += "\n  期望：" + excerpt(first.difference.expected, secrets)
        if (first.difference.actual !== undefined) message += "\n  返回：" + excerpt(first.difference.actual, secrets)
      }
    if (!this.details || !event.detailsIncluded) return message
    if (event.modelRequest) {
      message += `\nmodel=${event.modelRequest.model}; stream=${event.modelRequest.stream}`
      for (const item of event.modelRequest.messages) {
        if (item.role === "system") {
          const system = this.system(item.content, secrets)
          message += `\nsystem=${system.id}`
          if (system.definition === undefined) message += "（复用，见首次定义）"
          else message += `\n--- system ${system.id} ---\n${system.definition}`
        } else message += `\n--- ${item.role} ---\n${item.content}`
      }
    }
    if (event.modelResponse !== undefined) {
      const response = modelOutput(event.modelResponse)
      const title = response.raw ? "原始响应" : `assistant（finish_reason=${response.reason}）`
      message += `\n--- ${title} ---\n${response.text || "（空文本）"}`
    }
    return message
  }

  record(event: TranslationEvent, context: TranslationLogContext): void {
    let level: LogLevel = "info"
    if (event.kind === "finish" && (event.status === "partial" || event.status === "failed")) level = "error"
    else if (event.kind === "request" && event.failures.length && !event.cancelled) level = "warning"
    if (!this.enabled(level)) return
    if (event.kind === "request" && !this.details && (event.cancelled || !event.failures.length)) return
    const secrets = [context.apiKey]
    const id = event.kind === "request" ? event.requestId : event.taskId
    let message = `[${id}] ${context.file} · `
    if (event.kind === "start") {
      message += `任务开始：${event.total} 项 → ${context.targetLanguage}（${context.name} / ${context.model}）`
    } else if (event.kind === "request") {
      message += this.requestMessage(event, context, secrets)
    } else {
      message += finishMessage(event, context)
    }
    this.write(level, message, secrets)
  }
}
