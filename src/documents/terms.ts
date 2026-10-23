import { translationBody } from "./body.ts"
import { embedTranslation } from "./embedding.ts"
import type { TextUnit } from "../model/document.ts"
import type { PreserveTerm } from "../model/translation.ts"
import { ModelRetry } from "../model/diagnostics.ts"

const markerFeedback = "Keep every <CTP...> marker unchanged and exactly once in its own item, preserving pairing and nesting."

/** Validate and compile user regexes at the configuration boundary, with absolute body boundaries even in multiline mode. */
export function parsePreserveTerms(value: unknown): readonly PreserveTerm[] {
  if (!Array.isArray(value)) throw Error("preserveTerms 必须是字符串或正则对象的数组。")
  return value.map((term: unknown, index) => {
    const label = "preserveTerms 第 " + (index + 1) + " 项"
    if (typeof term === "string") {
      if (!term.trim()) throw Error(label + "必须是非空字符串。")
      return term
    }
    if (!term || typeof term !== "object" || Array.isArray(term)) throw Error(label + "必须是非空字符串或 { pattern, flags } 正则对象。")
    const entry = term as Record<string, unknown>
    if (
      typeof entry.pattern !== "string" ||
      !entry.pattern.length ||
      (entry.flags !== undefined && typeof entry.flags !== "string") ||
      Object.keys(entry).some((key) => key !== "pattern" && key !== "flags")
    )
      throw Error(label + "必须是包含非空 pattern 和可选 flags 的正则对象。")
    const flags = entry.flags ?? "u"
    if (!/^[imsu]*$/u.test(flags)) throw Error(label + "的 flags 只支持 i、m、s、u，不支持 g、y 等有状态标志。")
    try {
      const expression = new RegExp(entry.pattern, flags)
      return new RegExp("(?<![\\s\\S])(?:" + expression.source + ")(?![\\s\\S])", expression.flags)
    } catch {
      throw Error(label + "的正则表达式或 flags 无效。")
    }
  })
}

export function prepareTranslation(
  unit: TextUnit,
  preserveTerms: readonly PreserveTerm[],
  context = ""
): { text: string; source: string; hasMarkers: boolean; hasReferenceMarkers: boolean; needsTranslation: boolean; restore(text: string): string } {
  if (unit.embedding) {
    const prepared = prepareTranslation(unit.embedding.unit, preserveTerms, context)
    return { ...prepared, restore: (text) => embedTranslation(unit, prepared.restore(text)) }
  }
  const { original, source, start, end, ranges: protectedRanges, echoedPrefix } = translationBody(unit)
  let prefix = "<CTP"
  let namespace = 0
  while ([unit.text, original, context].some((value) => value.includes(prefix))) prefix = "<CTP" + ++namespace + "_"
  const markers = new Map<string, { value: string; pair?: string; side?: "open" | "close"; inlineCode?: boolean; lineBoundary?: boolean }>()
  let text = ""
  let position = 0
  let rangeIndex = 0
  let afterBreak = false

  function foldBreak() {
    text = text.replace(/[\t ]*$/u, "") + " "
    afterBreak = true
  }

  function mask(value: string, range: (typeof protectedRanges)[number]): string {
    const marker = prefix + markers.size + ">"
    markers.set(marker, {
      value,
      pair: range.pair,
      side: range.side,
      inlineCode: range.kind === "InlineCode",
      lineBoundary: range.kind === "LineBoundary" || (unit.language === "python" && unit.kind === "string")
    })
    return marker
  }

  while (position < source.length) {
    const range = protectedRanges[rangeIndex]
    if (range?.start === position) {
      if (range.fold) foldBreak()
      else {
        text += mask(source.slice(range.start, range.end), range)
        afterBreak = false
      }
      position = range.end
      rangeIndex++
      continue
    }
    const newline = source.startsWith("\r\n", position) ? "\r\n" : /[\r\n]/u.test(source[position]) ? source[position] : undefined
    if (newline) {
      foldBreak()
      position += newline.length
      continue
    }
    const character = source[position++]
    if (afterBreak && /[\t ]/u.test(character)) continue
    text += character
    afterBreak = false
  }
  const pattern = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[0-9]+>", "g")
  const remaining = text.replace(pattern, "")
  return {
    text,
    source,
    hasMarkers: markers.size > 0,
    hasReferenceMarkers: protectedRanges.some((range) => !range.fold),
    needsTranslation: !preserveTerms.some((term) => (typeof term === "string" ? term === source : term.test(source))) && !!remaining.trim() && (!markers.size || /\p{L}/u.test(remaining)),
    restore: (translated) => {
      // Only a source-owned Markdown prefix may be echoed; restore its exact original numbering and syntax locally.
      if (echoedPrefix) translated = translated.replace(echoedPrefix, "")
      // A key's field separator stays local; values and source-owned punctuation remain text.
      if (unit.yamlKey && !/[:：]\s*$/u.test(original)) translated = translated.replace(/([^:：\s])[:：](?=\s*$)/u, "$1")
      // An inline-code marker already owns its delimiters; remove only an exact echoed wrapper.
      translated = translated.replace(new RegExp("(?<!`)(`+)(" + pattern.source + ")\\1(?!`)", "g"), (match, ticks: string, marker: string) => {
        const value = markers.get(marker)
        return value?.inlineCode && value.value.match(/^`+/u)?.[0] === ticks ? marker : match
      })
      const matches = translated.match(pattern) ?? []
      const counts = new Map<string, number>()
      const stack: string[] = []
      for (const marker of matches) {
        const value = markers.get(marker)
        if (!value)
          throw new ModelRetry(
            { reason: `Unknown marker ${marker}.`, instruction: markerFeedback },
            {
              code: "translation-marker-mismatch",
              difference: { reason: "模型产生了无法识别的保护标记。", actual: marker }
            }
          )
        counts.set(marker, (counts.get(marker) ?? 0) + 1)
        if (value.side === "open") stack.push(value.pair!)
        else if (value.side === "close" && stack.pop() !== value.pair)
          throw new ModelRetry(
            { reason: `Marker ${marker} closes the wrong pair or nesting level.`, instruction: markerFeedback },
            {
              code: "translation-marker-mismatch",
              difference: { reason: "模型打乱了样式标记的配对或嵌套。" }
            }
          )
      }
      for (const [marker, { value }] of markers) {
        const count = counts.get(marker) ?? 0
        if (count !== 1)
          throw new ModelRetry(
            { reason: `Marker ${marker} occurred ${count} times; expected exactly once.`, instruction: markerFeedback },
            {
              code: "translation-marker-mismatch",
              difference: {
                reason: "模型未保留保护标记 " + marker + "。",
                expected: value,
                actual: count ? "对应标记重复 " + count + " 次" : "对应标记缺失或被改写"
              }
            }
          )
      }
      if (stack.length || translated.replace(pattern, "").includes(prefix))
        throw new ModelRetry(
          { reason: `An unclosed style pair or malformed marker with prefix ${prefix} remains.`, instruction: markerFeedback },
          {
            code: "translation-marker-mismatch",
            difference: { reason: "模型产生了无法识别或未闭合的保护标记。" }
          }
        )
      const boundaries = [...markers].filter(([, value]) => value.lineBoundary).map(([marker]) => marker)
      if (matches.filter((marker) => markers.get(marker)?.lineBoundary).some((marker, index) => marker !== boundaries[index]))
        throw new ModelRetry(
          { reason: "The response reordered structural boundaries.", instruction: "Keep structural boundary markers in their original order." },
          { code: "translation-marker-mismatch", difference: { reason: "模型改变了结构边界的顺序。" } }
        )
      // Normalize only a style's immediate interior whitespace, with at most one soft line break.
      // Blank lines, prose spacing, protected layouts, and source-owned outer spacing stay intact.
      translated = translated
        .replace(new RegExp("(" + pattern.source + ")([\\t \\r\\n]+)", "g"), (match, marker: string, space: string) =>
          markers.get(marker)?.side === "open" && /^[\t ]*(?:\r?\n[\t ]*)?$/u.test(space) ? marker : match
        )
        .replace(new RegExp("([\\t \\r\\n]+)(" + pattern.source + ")", "g"), (match, space: string, marker: string) =>
          markers.get(marker)?.side === "close" && /^[\t ]*(?:\r?\n[\t ]*)?$/u.test(space) ? marker : match
        )
      if (/[\r\n]/u.test(translated.trim()))
        throw new ModelRetry(
          {
            reason: "The response introduced an internal line break.",
            instruction: "Return each source item's translation on one line, keeping protected content unchanged and excluding explanatory lines."
          },
          {
            code: "translation-structure-invalid",
            difference: { reason: "待译正文已转换为单行，模型新增了内部换行，可能混入独立说明。", expected: "单行正文，跨行文本以单个空格连接", actual: "包含内部换行" }
          }
        )
      if (translated === text) return unit.text
      const restored = original.slice(0, start) + translated.replace(pattern, (marker) => markers.get(marker)!.value) + original.slice(end)
      if (unit.content === undefined) return restored
      if (restored === unit.content) return unit.text
      return JSON.stringify(restored) + (unit.text.match(/(?:\r?\n)+$/)?.[0] ?? "")
    }
  }
}
