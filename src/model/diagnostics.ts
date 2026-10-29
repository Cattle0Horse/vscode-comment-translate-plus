import type { TranslationDifference, ParseDiagnostic } from "./document.ts"

export class ParseFailure extends Error {
  constructor(readonly diagnostic: ParseDiagnostic) {
    super(diagnostic.code)
  }
}

const cancellationDescriptions = {
  "user-cancelled": "用户取消",
  "document-changed": "源文已变化",
  "document-closed": "源文件已关闭",
  "browse-stopped": "注释浏览已关闭",
  "configuration-changed": "翻译配置已变化",
  retranslation: "重新翻译替代旧请求",
  "hover-target-changed": "悬停目标已变化",
  "preview-refreshed": "预览刷新替代旧请求",
  "preview-closed": "译文预览已关闭",
  "extension-disposed": "扩展已释放",
  "consumer-released": "已无消费者需要该单元",
  "request-failed": "同一任务中的请求失败，停止其余请求",
  unspecified: "取消信号未提供具体原因"
}

export type CancellationReason = keyof typeof cancellationDescriptions

/** Abort reasons may come from external consumers; never print arbitrary errors or request data. */
export function cancellationReason(reason: unknown): CancellationReason {
  return typeof reason === "string" && Object.hasOwn(cancellationDescriptions, reason) ? (reason as CancellationReason) : "unspecified"
}

export function describeCancellation(reason: CancellationReason): string {
  return cancellationDescriptions[reason]
}

/** Keeps one already-reported service failure from being printed again by each consumer. */
export class TranslationFailure extends Error {
  constructor(
    code: string,
    readonly reported = false,
    readonly difference?: TranslationDifference
  ) {
    super(code)
  }
}

/** English model-facing feedback stays structured until the provider renders its request. */
export interface ModelFeedback {
  readonly reason: string
  readonly instruction: string
}

/** A validator explicitly asks the model to try again; log details remain separate. */
export class ModelRetry extends TranslationFailure {
  readonly advisory: boolean

  constructor(
    readonly feedback: ModelFeedback,
    options: { readonly code: string; readonly difference?: TranslationDifference; readonly advisory?: boolean }
  ) {
    super(options.code, false, options.difference ? { ...options.difference, modelReason: feedback.reason } : undefined)
    this.advisory = options.advisory ?? false
  }
}

/** A failed request may be retried without giving new instructions to the model. */
export class RequestRetry extends TranslationFailure {
  retryAt?: number
}

export function failureCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]+$/.test(error.message) ? error.message : "translation-failed"
}

export function describeError(code: string): string {
  if (code.startsWith("service-http-")) return "服务请求失败（HTTP " + code.slice("service-http-".length) + "），请检查地址、密钥、权限或限流设置。"
  const descriptions: Record<string, string> = {
    "prompt-template-invalid": "提示词条件片段无效，请使用固定变量名称，并配对 {{#if context}} 与 {{/if}}。",
    "translation-items-mismatch": "返回条目数量不匹配，无法确认对应关系的内容保留原文。",
    "translation-item-invalid": "服务返回了无效条目，对应内容保留原文。",
    "translation-structure-invalid": "服务改写了结构、代码或链接，对应内容保留原文。",
    "translation-marker-mismatch": "服务丢失、重复或改写了受保护标记，对应内容保留原文。",
    "translation-feedback-leaked": "服务将重试诊断混入译文，对应内容保留原文。",
    "translation-language-review": "译文可能不是目标语种，正在请求模型复核；检测仅供参考，允许保留合适的原文。",
    "translation-language-mismatch": "模型改写了正文，但译文仍有非目标语种证据，对应内容保留原文。",
    "translation-failed": "翻译未完成，请检查翻译配置并查看请求日志。",
    "service-response-incomplete": "模型没有完整结束生成，对应内容保留原文。",
    "service-response-invalid": "服务返回格式无效，对应内容保留原文。",
    "service-settings-incomplete": "翻译配置不完整，请检查模型及具体目标语言；目标语言不能为空或 auto。",
    "service-provider-unknown": "翻译服务未接入，请检查 profile 的 provider 设置。",
    "service-body-too-large": "服务返回内容超过大小限制，对应内容保留原文。",
    "service-text-too-large": "完整单元超出此翻译服务的输入上限，未截断送出。",
    "service-request-too-large": "完整单元及提示词超出请求字符预算，请提高 maxRequestCharacters 或缩短模板；未截断正文。",
    "service-bing-auth-invalid": "Bing 页面校验失败，可能需要验证或网页接口已变化。",
    "service-network-failed": "网络请求失败，请检查服务是否可访问；Web 宿主还需允许页面来源的 CORS 请求。",
    "service-timeout": "服务请求超时，可稍后重试。",
    "frontmatter-invalid": "YAML frontmatter 无法解析，已保留该区域原文。",
    "yaml-invalid": "YAML 无法解析，已保留原文。",
    "frontmatter-incomplete": "frontmatter 尚未闭合，补全后再翻译。",
    "language-grammar-unavailable": "当前语言的 TextMate 语法不可用，请检查对应语言扩展。",
    "language-tokenization-timeout": "语法识别超时，未用不完整结果翻译。"
  }
  return descriptions[code] ?? "翻译失败，对应区域保留原文。"
}
