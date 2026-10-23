import type { RequestGate } from "./requestGate.ts"
import type { HttpResponse } from "./providers/protocol.ts"
import { RequestRetry } from "../model/diagnostics.ts"

export async function request(gate: RequestGate, url: string, init: Omit<RequestInit, "signal">, signal: AbortSignal, started?: () => void): Promise<HttpResponse> {
  return gate.run(async () => {
    started?.()
    const timeout = AbortSignal.timeout(60000)
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) })
      if (!response.ok) {
        await response.body?.cancel()
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
      if (timeout.aborted) throw new RequestRetry("service-timeout")
      if (error instanceof TypeError) throw new RequestRetry("service-network-failed")
      throw error
    }
  }, signal)
}
