type ProviderType = 'anthropic' | 'openai' | 'azure_openai'

interface ProviderConfig {
  provider: ProviderType
  enabled: boolean
  apiKey?: string
  endpoint?: string
  apiVersion?: string
  deployment?: string
  model?: string
}

export function validateProviderConfig(config: ProviderConfig) {
  if (!config.enabled) return { ok: true }
  if (!config.apiKey) return { ok: false, reason: 'Missing API key' }
  
  if (config.provider === 'azure_openai') {
    if (!config.endpoint) return { ok: false, reason: 'Missing Azure endpoint' }
  }
  
  return { ok: true }
}
