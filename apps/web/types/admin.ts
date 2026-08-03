export type ProviderType = 'anthropic' | 'openai' | 'azure_openai'

export interface ProviderConfig {
  provider: ProviderType
  enabled: boolean
  apiKey?: string
  hasApiKey?: boolean
  endpoint?: string
  apiVersion?: string
  deployment?: string
}

export interface AgentProfile {
  id: string
  name: string
  purpose: string
  systemPrompt: string
  enabledTools: string[]
  guardrails: string[]
  enabled: boolean
  provider: ProviderType
  model: string
}

export interface PendoSettings {
  integrationKey?: string
  hasIntegrationKey?: boolean
  apiEndpoint?: string
}

export interface GeneralSettings {
  maxTokens?: number
}

export interface AdminState {
  providers: ProviderConfig[]
  agents: AgentProfile[]
  pendo: PendoSettings
  settings: GeneralSettings
}
