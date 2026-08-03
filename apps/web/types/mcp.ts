export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpOAuthMetadata {
  resource?: string
  authorizationServer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  scopesSupported?: string[]
}

export interface McpOAuthClient {
  clientId: string
  clientSecret?: string
  redirectUri: string
  scope?: string
  registrationAccessToken?: string
  registrationClientUri?: string
}

export interface McpOAuthTokens {
  accessToken: string
  refreshToken?: string
  tokenType: string
  expiresAt?: number
  scope?: string
}

export interface McpOAuthState {
  metadata?: McpOAuthMetadata
  client?: McpOAuthClient
  tokens?: McpOAuthTokens
  /** Last error from auth flow, surfaced to UI. */
  lastError?: string
  /** Set when the server reports it requires authentication but we have no token. */
  needsAuth?: boolean
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'http_sse'
  url: string
  enabled: boolean
  cachedTools?: McpTool[]
  lastConnectedAt?: string
  oauth?: McpOAuthState
  /** True when the client has tokens (mirror of oauth.tokens?.accessToken without leaking the token). Set by API responses. */
  hasOAuthTokens?: boolean
}
