import prisma from '@/lib/db'

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null
let _modelCacheExpiry = 0

let _cachedProvider: 'anthropic' | 'openai' | 'minimax' | null = null
let _providerCacheExpiry = 0

let _cachedOpenAIModel: string | null = null
let _openAIModelCacheExpiry = 0

let _cachedMiniMaxModel: string | null = null
let _miniMaxModelCacheExpiry = 0

// Cached separately from _cachedOpenAIModel: this one must preserve the
// difference between "set" and "unset", which the defaulted accessor erases.
let _cachedCodexModel: string | null = null
let _codexModelCacheExpiry = 0
let _codexModelCached = false

const CACHE_TTL = 5 * 60 * 1000

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(): Promise<string> {
  if (_cachedModel && Date.now() < _modelCacheExpiry) return _cachedModel
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicModel' } })
  _cachedModel = setting?.value ?? 'claude-haiku-4-5-20251001'
  _modelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedModel
}

/**
 * Get the active AI provider (cached for 5 minutes).
 */
export async function getProvider(): Promise<'anthropic' | 'openai' | 'minimax'> {
  if (_cachedProvider && Date.now() < _providerCacheExpiry) return _cachedProvider
  const setting = await prisma.setting.findUnique({ where: { key: 'aiProvider' } })
  const val = setting?.value
  _cachedProvider = val === 'openai' ? 'openai' : val === 'minimax' ? 'minimax' : 'anthropic'
  _providerCacheExpiry = Date.now() + CACHE_TTL
  return _cachedProvider
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedOpenAIModel = setting?.value ?? 'gpt-4.1-mini'
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedOpenAIModel
}

/**
 * Model slug for the Codex CLI (`codex exec --model`), read from the same
 * `openaiModel` setting the Settings screen already exposes.
 *
 * Returns undefined when the row is unset or blank so codexPrompt omits --model
 * and the CLI picks its own default — passing an id the CLI rejects would fail
 * the whole call, which is worse than not steering it.
 *
 * NOTE: Codex slugs (gpt-5.6-luna, gpt-5.6-sol) are a different namespace from
 * the OpenAI API model names getOpenAIModel() hands the SDK. One row feeds both
 * because the UI exposes one box; under `auth_mode: chatgpt` the SDK path is a
 * hard error anyway (openai-auth.ts:67), so only the CLI value is live today.
 */
export async function getCodexModel(): Promise<string | undefined> {
  if (_codexModelCached && Date.now() < _codexModelCacheExpiry) {
    return _cachedCodexModel ?? undefined
  }
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedCodexModel = setting?.value?.trim() || null
  _codexModelCacheExpiry = Date.now() + CACHE_TTL
  _codexModelCached = true
  return _cachedCodexModel ?? undefined
}

/**
 * Get the configured MiniMax model from settings (cached for 5 minutes).
 */
export async function getMiniMaxModel(): Promise<string> {
  if (_cachedMiniMaxModel && Date.now() < _miniMaxModelCacheExpiry) return _cachedMiniMaxModel
  const setting = await prisma.setting.findUnique({ where: { key: 'minimaxModel' } })
  _cachedMiniMaxModel = setting?.value ?? 'MiniMax-M2.7'
  _miniMaxModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedMiniMaxModel
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(): Promise<string> {
  const provider = await getProvider()
  if (provider === 'minimax') return getMiniMaxModel()
  return provider === 'openai' ? getOpenAIModel() : getAnthropicModel()
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedModel = null
  _modelCacheExpiry = 0
  _cachedProvider = null
  _providerCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
  _cachedMiniMaxModel = null
  _miniMaxModelCacheExpiry = 0
  _cachedCodexModel = null
  _codexModelCacheExpiry = 0
  _codexModelCached = false
}
