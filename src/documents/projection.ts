import type { TextUnit } from "../model/document.ts"
import { embedTranslation, unembedTranslation } from "./embedding.ts"

export function projectionContent(unit: TextUnit, text: string): string {
  const projection = unit.projection
  if (!projection) throw Error("translation-structure-invalid")
  return projection.kind === "container" ? unembedTranslation(unit, text) : projection.codec.content(text)
}

export function restoreProjection(unit: TextUnit, text: string): string {
  const projection = unit.projection
  if (!projection) throw Error("translation-structure-invalid")
  return projection.kind === "container" ? embedTranslation(unit, text) : projection.codec.restore(text)
}
