export async function localServiceFromEnvironment() {
  try {
    process.loadEnvFile()
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  return localServiceProfile({
    profileId: process.env.COMMENT_TRANSLATE_TEST_PROFILE_ID,
    apiUrl: process.env.COMMENT_TRANSLATE_TEST_API_URL,
    model: process.env.COMMENT_TRANSLATE_TEST_MODEL,
    apiKey: process.env.COMMENT_TRANSLATE_TEST_API_KEY
  })
}

export async function localServiceProfile({ profileId, apiUrl, model, apiKey = "" } = {}) {
  if (profileId !== undefined && typeof profileId !== "string") throw Error("COMMENT_TRANSLATE_TEST_PROFILE_ID must be a string.")
  if (typeof apiUrl !== "string" || !apiUrl.trim()) throw Error("Local tests require COMMENT_TRANSLATE_TEST_API_URL.")
  const url = new URL(apiUrl)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/chat/completions")
  ) {
    throw Error("Local tests require a loopback Chat Completions URL without credentials or query parameters.")
  }
  const label = profileId?.trim()
  profileId = label || url.href
  if (!model) {
    const modelsUrl = new URL(url)
    modelsUrl.pathname = modelsUrl.pathname.slice(0, -"/chat/completions".length) + "/models"
    const response = await fetch(modelsUrl, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw Error(`Local model discovery failed: HTTP ${response.status}`)
    const body = await response.json()
    if (!body || !Array.isArray(body.data) || body.data.length !== 1 || typeof body.data[0]?.id !== "string" || !body.data[0].id.trim()) {
      throw Error("Model discovery requires exactly one model. Set COMMENT_TRANSLATE_TEST_MODEL explicitly.")
    }
    model = body.data[0].id
  }
  return {
    settings: {
      profiles: [{ id: profileId, name: label || url.host, provider: "openai", apiUrl: url.href, model }],
      activeProfile: profileId,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      maxItemsPerRequest: 20,
      maxRequestCharacters: 12000,
      maxRequestsPerSecond: 2,
      maxConcurrentRequests: 1
    },
    apiKey
  }
}
