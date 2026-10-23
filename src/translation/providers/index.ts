import { openai } from "./openai.ts"
import { google } from "./google.ts"
import { bing } from "./bing.ts"
import type { TranslationProvider } from "./protocol.ts"

export const providers: readonly TranslationProvider[] = [openai, google, bing]

export function getProvider(id: string): TranslationProvider {
  const provider = providers.find((provider) => provider.id === id)
  if (!provider) throw Error("service-provider-unknown")
  return provider
}
