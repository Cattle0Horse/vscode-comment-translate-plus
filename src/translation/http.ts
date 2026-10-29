import type { RequestGate } from "./requestGate.ts"
import type { HttpResponse } from "./providers/protocol.ts"
import { RequestRetry } from "../model/diagnostics.ts"
import type { ServiceSettings } from "./settings.ts"
import { requestScope, retryAfterDelay } from "./transport.ts"

export async function request(
  gate: RequestGate,
  url: string,
  init: Omit<RequestInit, "signal">,
  signal: AbortSignal,
  settings: ServiceSettings,
  attempt: number,
  notBefore: number,
  started?: () => void,
  priority?: () => number
): Promise<HttpResponse> {
  const scope = requestScope(settings)
  return gate.run(
    async () => {
      started?.()
      const version = gate.version(scope)
      const timeout = AbortSignal.timeout(60000)
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) })
        if (!response.ok) {
          const retryAfter = settings.respectRetryAfter ? retryAfterDelay(response.headers.get("retry-after")) : undefined
          await response.body?.cancel()
          if ((response.status === 429 && settings.retryHttp429) || (response.status === 503 && settings.retryHttp503)) {
            const error = new RequestRetry("service-http-" + response.status)
            error.retryAt = gate.failed(scope, settings, attempt, retryAfter, true, version)
            throw error
          }
          throw Error("service-http-" + response.status)
        }
        const reader = response.body?.getReader()
        if (!reader) throw Error("service-body-missing")
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 2_000_000) throw Error("service-body-too-large")
            chunks.push(value)
          }
        } finally {
          await reader.cancel()
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        gate.succeeded(scope, version)
        return {
          text: new TextDecoder().decode(bytes),
          url: response.url,
          cookies: response.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; ")
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (timeout.aborted || error instanceof TypeError) {
          const retry = new RequestRetry(timeout.aborted ? "service-timeout" : "service-network-failed")
          retry.retryAt = gate.failed(scope, settings, attempt, 0, false, version)
          throw retry
        }
        throw error
      }
    },
    signal,
    priority,
    scope,
    notBefore
  )
}
