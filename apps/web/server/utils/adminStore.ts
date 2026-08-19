import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dbGetJson, dbSetJson } from '../db/client'
import type { McpServerConfig } from '~/types/mcp'

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'azure_openai'
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
  provider: 'anthropic' | 'openai' | 'azure_openai'
  model: string
}

export interface PendoSettings {
  integrationKey?: string
  hasIntegrationKey?: boolean
  apiEndpoint?: string
  defaultAppId?: number
}

/**
 * Pendo Agent Analytics — where this app reports its OWN agent conversations,
 * which is a different destination from the aggregation API above.
 *
 * These were previously baked into `nuxt.config.ts`, which meant every install
 * that never touched the env vars streamed its prompts and answers into
 * whichever Pendo subscription those constants belonged to. Configuring them
 * per workspace is what makes the destination the operator's own choice.
 *
 * `apiKey` is a Pendo *Public App ID* — the same value a browser snippet
 * carries — so it is not masked on the way to the client; being able to read it
 * back is how you confirm which subscription you are reporting into.
 */
export interface PendoAgentSettings {
  /** Master switch. Off means no spans are created at all. */
  enabled?: boolean
  /** Pendo Public App ID. */
  apiKey?: string
  /** Identifies this agent within the subscription. */
  agentId?: string
  /** Defaults to https://app.pendo.io. */
  endpoint?: string
  /** Strip email/phone/SSN from event content before export. */
  redact?: boolean
  /** Fallbacks when a turn can't resolve an identity from the request. */
  defaultVisitorId?: string
  defaultAccountId?: string
}

export interface CustomSkill {
  id: string
  name: string
  triggers: string
  content: string
  enabled: boolean
}

export interface GeneralSettings {
  maxTokens?: number
  /**
   * Free-form instructions the user wants the agent to follow on every turn
   * in this workspace. Injected into the dynamic (uncached) section of the
   * system prompt by `buildSystemPrompt`, so edits take effect immediately
   * without invalidating the cached prefix.
   */
  agentInstructions?: string
  /**
   * Workspace-defined skills. Each enabled skill is injected into the system
   * prompt (uncached layer) along with its trigger description so the agent
   * can match user requests to the right one. Different workspaces keep their
   * own templates here — e.g. their own onboarding maturity matrix, QBR
   * outline, etc.
   */
  customSkills?: CustomSkill[]
}

export interface AdminState {
  providers: ProviderConfig[]
  agents: AgentProfile[]
  pendo: PendoSettings
  /** Absent means "never configured" — tracing then falls back to env vars. */
  pendoAgent?: PendoAgentSettings
  settings: GeneralSettings
  mcpServers?: McpServerConfig[]
}

const defaultState: AdminState = {
  providers: [
    { provider: 'anthropic', enabled: false },
    { provider: 'openai', enabled: false },
    { provider: 'azure_openai', enabled: false }
  ],
  agents: [],
  pendo: {},
  settings: { maxTokens: 2000 }
}

function dataPath() {
  return resolve(process.cwd(), '.data', 'admin.json')
}

async function ensureDir() {
  await mkdir(resolve(process.cwd(), '.data'), { recursive: true })
}

export async function readAdminState(orgId = 'default'): Promise<AdminState> {
  const kvKey = `org:${orgId}:admin_state`

  // Use null as the sentinel so we can distinguish "key not in DB" from
  // "key in DB with empty/default content".
  const fromDb = dbGetJson<AdminState | null>(kvKey, null)

  // If the key exists in the DB, return its content (merging missing fields from defaults).
  if (fromDb !== null) {
    return {
      providers: fromDb.providers ?? defaultState.providers,
      agents: fromDb.agents ?? defaultState.agents,
      pendo: fromDb.pendo ?? defaultState.pendo,
      pendoAgent: fromDb.pendoAgent,
      settings: fromDb.settings ?? defaultState.settings,
      mcpServers: fromDb.mcpServers ?? []
    }
  }

  // For the default org only: backward-compatible fallback to legacy key or JSON file.
  if (orgId === 'default') {
    const legacy = dbGetJson<AdminState | null>('admin_state', null)
    if (legacy !== null) {
      const normalized = {
        providers: legacy.providers ?? defaultState.providers,
        agents: legacy.agents ?? defaultState.agents,
        pendo: legacy.pendo ?? defaultState.pendo,
        pendoAgent: legacy.pendoAgent,
        settings: legacy.settings ?? defaultState.settings,
        mcpServers: legacy.mcpServers ?? []
      }
      // Migrate to org-scoped key
      dbSetJson(kvKey, normalized)
      return normalized
    }

    // Backward-compatible fallback: import existing JSON file once.
    try {
      const raw = await readFile(dataPath(), 'utf8')
      const parsed = JSON.parse(raw) as AdminState
      const normalized = {
        providers: parsed.providers ?? defaultState.providers,
        agents: parsed.agents ?? defaultState.agents,
        pendo: parsed.pendo ?? defaultState.pendo,
        pendoAgent: parsed.pendoAgent,
        settings: parsed.settings ?? defaultState.settings,
        mcpServers: parsed.mcpServers ?? []
      }
      dbSetJson(kvKey, normalized)
      return normalized
    } catch {
      // Fall through to default state
    }
  }

  return structuredClone(defaultState)
}

export async function writeAdminState(next: AdminState, orgId = 'default'): Promise<void> {
  dbSetJson(`org:${orgId}:admin_state`, next)

  // Keep legacy file write for the default org for compatibility during rollout.
  if (orgId === 'default') {
    await ensureDir()
    await writeFile(dataPath(), JSON.stringify(next, null, 2), 'utf8')
  }
}

/**
 * Which configured agent handles a turn.
 *
 * Every question/chat endpoint used to hardcode `enabledAgents[0]`, so a
 * workspace with several agents configured had no way to actually pick one —
 * whichever sorted first in `state.agents` silently handled every request.
 * A caller now names an agent by id; an id that doesn't match an *enabled*
 * agent falls back to the first enabled one rather than erroring, so a stale
 * selection (the chosen agent got disabled or deleted) degrades instead of
 * blocking the turn.
 */
export function resolveAgent(enabledAgents: AgentProfile[], requestedId?: string | null): AgentProfile {
  if (!enabledAgents.length) {
    throw new Error('No agents configured. Please configure an agent in Admin.')
  }
  if (requestedId) {
    const match = enabledAgents.find(a => a.id === requestedId)
    if (match) return match
  }
  return enabledAgents[0]
}

export function maskProviderSecrets(provider: ProviderConfig): ProviderConfig {
  const hasApiKey = Boolean(provider.apiKey)
  if (!hasApiKey) return { ...provider, hasApiKey: false }
  return { ...provider, apiKey: undefined, hasApiKey: true }
}

export function maskPendoSecrets(settings: PendoSettings): PendoSettings {
  const hasIntegrationKey = Boolean(settings.integrationKey)
  if (!hasIntegrationKey) return { ...settings, hasIntegrationKey: false }
  return { ...settings, integrationKey: undefined, hasIntegrationKey: true }
}

export function getDefaultAppId(settings: PendoSettings): number | undefined {
  return settings.defaultAppId
}

/**
 * Strip secret material from an MCP server config before returning to the client.
 * Replace tokens/secrets with a boolean flag so the UI can render auth status.
 */
export function maskMcpServer(server: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...server }
  if (server.oauth) {
    out.hasOAuthTokens = Boolean(server.oauth.tokens?.accessToken)
    out.oauth = {
      metadata: server.oauth.metadata,
      client: server.oauth.client
        ? { ...server.oauth.client, clientSecret: undefined, registrationAccessToken: undefined }
        : undefined,
      tokens: undefined,
      needsAuth: server.oauth.needsAuth,
      lastError: server.oauth.lastError
    }
  } else {
    out.hasOAuthTokens = false
  }
  return out
}

/**
 * Merge an incoming MCP server config from the client with the existing stored value,
 * preserving server-only secrets (oauth tokens, client secret) that the client never sees.
 */
export function mergeMcpServer(incoming: McpServerConfig, existing: McpServerConfig | undefined): McpServerConfig {
  if (!existing?.oauth) return { ...incoming }
  const preserved = { ...incoming, oauth: { ...(incoming.oauth ?? {}) } }
  preserved.oauth = {
    ...preserved.oauth,
    metadata: incoming.oauth?.metadata ?? existing.oauth.metadata,
    client: existing.oauth.client
      ? {
          ...existing.oauth.client,
          // Allow client to update redirectUri/scope from UI if they sent them
          redirectUri: incoming.oauth?.client?.redirectUri ?? existing.oauth.client.redirectUri,
          scope: incoming.oauth?.client?.scope ?? existing.oauth.client.scope
        }
      : incoming.oauth?.client,
    tokens: existing.oauth.tokens,
    needsAuth: existing.oauth.needsAuth,
    lastError: existing.oauth.lastError
  }
  return preserved
}
