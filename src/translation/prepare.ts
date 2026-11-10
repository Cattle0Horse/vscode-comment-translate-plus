import type { PreparedInput, TranslationInput } from "../model/translation.ts"
import type { ReferenceBlock } from "../model/document.ts"
import type { ServiceSettings } from "./settings.ts"
import { getProvider } from "./providers/index.ts"
import { isPreservedTerm, prepareTranslation } from "../documents/terms.ts"
import { referenceCandidates, referenceText } from "../documents/references.ts"
import { redactSensitiveText, sensitiveValues } from "../documents/secrets.ts"

/** Resolve references before cache lookup so the key describes what this unit can actually send. */
export async function prepareInput(settings: ServiceSettings, input: TranslationInput): Promise<PreparedInput> {
  const provider = getProvider(settings.provider)
  return {
    units: await Promise.all(
      input.units.map(async (unit) => {
        const reference: ReferenceBlock[] = []
        const texts = [unit.text, unit.content ?? "", ...(unit.reference?.map((block) => block.text) ?? [])]
        const secrets = (await sensitiveValues(texts, [settings.apiKey])).filter((value) => texts.some((text) => text.includes(value)))
        const source: PreparedInput["units"][number] = { ...unit, reference, preserved: isPreservedTerm(unit, settings.preserveTerms) ? true : undefined, sensitiveValues: secrets }
        if (source.preserved || !settings.includeContext || settings.maxContextCharacters <= 0) return source
        const original = prepareTranslation(unit, settings.minimumMarkerCharacters)
        // Folding prose line breaks alone does not require a duplicate source reference.
        for (const blocks of referenceCandidates(unit, original)) {
          const first = blocks[0]
          if (first.alternative !== undefined && reference.some((selected) => selected.alternative === first.alternative)) continue
          if (first.kind === "Original" && reference.some((selected) => selected.range && selected.range.start <= unit.start && selected.range.end >= unit.end)) continue
          const candidate = [...reference, ...blocks]
          const context = referenceText([{ source: { ...unit, reference: candidate }, hasMarkers: original.hasMarkers }])
          // Reference text can affect only marker namespace selection. Reuse the
          // prepared body unless it introduces a possible namespace collision.
          const item = context.includes("<CTP") ? prepareTranslation(unit, settings.minimumMarkerCharacters, context) : original
          const size = await provider.prepare({
            settings,
            context: redactSensitiveText(context, secrets),
            items: [{ id: unit.id, text: item.text, format: unit.format, kind: unit.kind, hasMarkers: item.hasMarkers }]
          })
          if (size.referenceCharacters && size.characters <= settings.maxRequestCharacters && size.referenceCharacters <= settings.maxContextCharacters) reference.push(...blocks)
        }
        return source
      })
    )
  }
}
