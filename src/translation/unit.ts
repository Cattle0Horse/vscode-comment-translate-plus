import type { PreparedInput } from "../model/translation.ts"
import type { FailedTranslation } from "../model/events.ts"
import { ModelRetry, TranslationFailure, describeError, failureCode } from "../model/diagnostics.ts"
import { prepareTranslation } from "../documents/terms.ts"
import { validateTranslation, translationIsUnchanged } from "../documents/validation.ts"
import { isTargetLanguage, unlikelyTargetLanguage } from "../documents/languageDetection.ts"
import type { ServiceSettings } from "./settings.ts"
import type { TranslationProvider } from "./providers/protocol.ts"

export class TranslationUnit {
  prepared?: ReturnType<typeof prepareTranslation>
  translation?: string
  failure?: unknown
  feedback?: ModelRetry
  attempts = 0
  skipped = false
  private languageReviewed = false

  constructor(
    readonly source: PreparedInput["units"][number],
    private readonly settings: ServiceSettings,
    private readonly provider: TranslationProvider,
    readonly interest?: AbortSignal
  ) {}

  get wanted(): boolean {
    return !this.interest?.aborted
  }

  get pending(): boolean {
    return this.wanted && this.translation === undefined
  }

  get canRetry(): boolean {
    return this.pending && this.attempts < this.settings.maxTranslationAttempts
  }

  prepare(collisions: string): void {
    if (this.settings.skipSameLanguage && isTargetLanguage(this.source, this.settings.targetLanguage)) {
      this.skipped = true
      this.translation = this.source.text
    } else this.prepared = prepareTranslation(this.source, this.settings.preserveTerms, this.settings.minimumMarkerCharacters, collisions)
  }

  beginAttempt(): void {
    if (!this.canRetry) throw Error("translation-attempts-exhausted")
    this.attempts++
  }

  reject(error: unknown): void {
    this.failure = error
    // Transport failures do not invalidate the last model correction.
    if (error instanceof ModelRetry) this.feedback = error
  }

  accept(text: string, canReview: (review: ModelRetry) => boolean, diagnosticCodes: readonly string[] = []): void {
    const restored = this.prepared!.restore(text)
    const failure = validateTranslation(this.source, restored)
    if (failure) throw failure
    const leaked = diagnosticCodes.find((code) => text.includes(code) && !(this.source.content ?? this.source.text).includes(code))
    if (leaked)
      throw new ModelRetry(
        {
          reason: "The response included a retry diagnostic identifier absent from the source.",
          instruction: `Exclude diagnostic text, including ${leaked}, and explanations from the translation.`
        },
        {
          code: "translation-feedback-leaked",
          difference: { reason: "模型将重试错误标识混入译文。", expected: "仅翻译当前原文，不翻译或引用重试诊断。", actual: leaked }
        }
      )
    const unchanged = translationIsUnchanged(this.source, restored)
    this.reviewLanguage(text, unchanged, canReview)
    this.translation = unchanged ? this.source.text : restored
    this.failure = undefined
    this.feedback = undefined
  }

  private reviewLanguage(text: string, unchanged: boolean, canReview: (review: ModelRetry) => boolean): void {
    if (this.provider.id !== "openai" || !this.prepared!.needsTranslation) return
    if (unchanged && (this.languageReviewed || this.attempts >= this.settings.maxTranslationAttempts)) return
    const evidence = unlikelyTargetLanguage(text, this.settings.targetLanguage)
    if (!evidence) return
    const names = new Intl.DisplayNames(["en"], { type: "language" })
    const languageName = (code: string): string => (Object.hasOwn(this.settings.languageNames, code) ? this.settings.languageNames[code] : names.of(code)!)
    const targetLanguage = languageName(this.settings.targetLanguage.trim())
    const review = new ModelRetry(
      {
        reason: `The response may be in ${languageName(evidence.language)} instead of ${targetLanguage}.`,
        instruction: `Translate the source into ${targetLanguage}. Preserve wording only where translation is unnecessary.`
      },
      {
        code: unchanged ? "translation-language-review" : "translation-language-mismatch",
        advisory: true,
        difference: {
          reason: unchanged ? "译文语种与目标语种可能不一致；检测仅供参考，不能据此认定模型选择有误。" : "模型改写了正文，但译文仍有非目标语种证据；检测评分不是校准概率。",
          expected: this.settings.targetLanguage,
          actual: `${evidence.language}，匹配评分 ${evidence.score.toFixed(3)}，目标语种评分 ${evidence.targetScore.toFixed(3)}（非校准概率）`
        }
      }
    )
    if (unchanged && !canReview(review)) return
    this.languageReviewed = true
    throw review
  }

  diagnostic(error = this.failure, includeDifference = true): FailedTranslation {
    const code = failureCode(error)
    return {
      id: this.source.id,
      start: this.source.start,
      source: this.source.content ?? this.source.text,
      attempts: this.attempts,
      code,
      difference: includeDifference && error instanceof TranslationFailure && error.difference ? error.difference : { reason: describeError(code) }
    }
  }
}
