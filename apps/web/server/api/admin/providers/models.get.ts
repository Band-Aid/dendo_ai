import { defineEventHandler, getQuery, createError } from 'h3'
import { readAdminState } from '~/server/utils/adminStore'

interface ModelListResponse {
  models: string[]
  cached?: boolean
}

// Cache models for 1 hour to avoid excessive API calls
const modelCache = new Map<string, { models: string[]; timestamp: number }>()
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

export default defineEventHandler(async (event): Promise<ModelListResponse> => {
  const query = getQuery(event)
  const provider = query.provider as string

  if (!provider) {
    throw createError({ statusCode: 400, message: 'Provider is required' })
  }

  // Get API key from admin state
  const orgId = event.context.orgId as string
  const state = await readAdminState(orgId)
  const providerConfig = state.providers.find(p => p.provider === provider)

  if (!providerConfig?.apiKey) {
    throw createError({
      statusCode: 400,
      message: `API key not configured for ${provider}. Please add it in the Providers tab.`
    })
  }

  // Cache key includes the Azure deployment so renaming the deployment doesn't
  // serve a stale model list for the hour.
  const cacheKey = provider === 'azure_openai'
    ? `azure_openai:${providerConfig.deployment ?? ''}`
    : provider
  const cached = modelCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { models: cached.models, cached: true }
  }

  try {
    let models: string[] = []

    switch (provider) {
      case 'anthropic':
        models = await fetchAnthropicModels(providerConfig.apiKey)
        break

      case 'openai':
        models = await fetchOpenAIModels(providerConfig.apiKey)
        break

      case 'azure_openai':
        // The deployment IS the model on Azure — surface it directly so the
        // dropdown reflects what's actually deployed (e.g. `claude-opus-4-6`)
        // rather than a hardcoded OpenAI list that has nothing to do with it.
        models = providerConfig.deployment?.trim()
          ? [providerConfig.deployment.trim()]
          : ['gpt-4o', 'gpt-4', 'gpt-4-32k', 'gpt-35-turbo', 'gpt-35-turbo-16k']
        break

      default:
        throw createError({ statusCode: 400, message: `Unknown provider: ${provider}` })
    }

    // Update cache
    modelCache.set(cacheKey, { models, timestamp: Date.now() })

    return { models, cached: false }
  } catch (error: any) {
    console.error(`Failed to fetch models for ${provider}:`, error.message)
    throw createError({
      statusCode: 500,
      message: `Failed to fetch models: ${error.message}`
    })
  }
})

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  
  // Anthropic returns { data: [...], has_more: false, first_id: "...", last_id: "..." }
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Unexpected response format from Anthropic API')
  }

  const models = data.data
    .map((m: any) => m.id)
    .filter((id: string) => id && id.startsWith('claude-'))
  
  if (models.length === 0) {
    throw new Error('No Claude models found in API response')
  }

  return models
}

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Unexpected response format from OpenAI API')
  }

  // Filter to only GPT models and sort by relevance
  const gptModels = data.data
    .map((m: any) => m.id)
    .filter((id: string) => id && id.startsWith('gpt-'))
    .sort((a: string, b: string) => {
      // Prioritize newer models
      const priority: Record<string, number> = {
        'gpt-4o': 1,
        'gpt-4o-mini': 2,
        'gpt-4-turbo': 3,
        'gpt-4': 4,
        'gpt-3.5-turbo': 5
      }
      return (priority[a] || 999) - (priority[b] || 999)
    })
  
  if (gptModels.length === 0) {
    throw new Error('No GPT models found in API response')
  }

  return gptModels
}
