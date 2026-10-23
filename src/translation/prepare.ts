import type { PreparedInput, TranslationInput } from "../model/translation.ts"
import type { ReferenceBlock } from "../model/document.ts"
import type { ServiceSettings } from "./settings.ts"
import { getProvider } from "./providers/index.ts"
import { prepareTranslation } from "../documents/terms.ts"
import { referenceCandidates, referenceText } from "../documents/references.ts"

/** Resolve references before cache lookup so the key describes what this unit can actually send. */
export function prepareInput(settings: ServiceSettings, input: TranslationInput): PreparedInput {
  const provider = getProvider(settings.provider)
  return {
    units: input.units.map((unit) => {
      const reference: ReferenceBlock[] = []
      if (settings.maxContextCharacters <= 0) return { ...unit, reference }
      const original = prepareTranslation(unit, settings.preserveTerms)
      // Folding prose line breaks alone does not require a duplicate source reference.
      const hasMarkers = original.hasReferenceMarkers
      for (const blocks of referenceCandidates(unit, { source: original.source, hasMarkers })) {
        const first = blocks[0]
        if (first.alternative !== undefined && reference.some((selected) => selected.alternative === first.alternative)) continue
        if (first.kind === "Original" && reference.some((selected) => selected.range && selected.range.start <= unit.start && selected.range.end >= unit.end)) continue
        const candidate = [...reference, ...blocks]
        const context = referenceText([{ source: { ...unit, reference: candidate }, hasMarkers }])
        if (context.length > settings.maxUnitContextCharacters) continue
        // Reference text can affect only marker namespace selection. Reuse the
        // prepared body unless it introduces a possible namespace collision.
        const item = context.includes("<CTP") ? prepareTranslation(unit, settings.preserveTerms, context) : original
        const size = provider.prepare({
          settings,
          context,
          items: [{ id: unit.id, text: item.text, format: unit.format, kind: unit.kind, hasMarkers: item.hasMarkers }]
        })
        if (size.referenceCharacters && size.characters <= settings.maxRequestCharacters && size.referenceCharacters <= settings.maxContextCharacters) reference.push(...blocks)
      }
      return { ...unit, reference }
    })
  }
}
