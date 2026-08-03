import { createHash, randomBytes } from 'node:crypto'
import type { McpOAuthClient, McpOAuthMetadata, McpOAuthTokens, McpServerConfig } from '~/types/mcp'

const DISCOVERY_TIMEOUT_MS = 10_000
const TOKEN_TIMEOUT_MS = 15_000
/** Skew applied when deciding whether the current access token is still usable. */
const REFRESH_SKEW_SEC = 30

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: any; headers: Headers }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal })
    const text = await resp.text()
    let body: any = text
    try { body = text ? JSON.parse(text) : null } catch { /* leave as string */ }
    return { status: resp.status, body, headers: resp.headers }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Look for a 401 response on the MCP endpoint and pull out the resource-metadata URL
 * from the WWW-Authenticate challenge (RFC 9728 §5.1).
 */
export async function probeResourceMetadataUrl(mcpUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dendo', version: '0.1' } } })
    })
    if (resp.status !== 401) return null
    const challenge = resp.headers.get('www-authenticate') || ''
    const match = /resource_metadata="?([^",\s]+)"?/i.exec(challenge)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function defaultProtectedResourceUrl(mcpUrl: string): string {
  const u = new URL(mcpUrl)
  return `${u.origin}/.well-known/oauth-protected-resource`
}

/**
 * Discover OAuth metadata for the MCP server. Tries (in order):
 *  1. WWW-Authenticate `resource_metadata` URL surfaced on 401.
 *  2. `<origin>/.well-known/oauth-protected-resource`.
 *  3. Fallback: treat the MCP server origin as the authorization server itself.
 */
export async function discoverOAuthMetadata(mcpUrl: string): Promise<McpOAuthMetadata> {
  const candidates: string[] = []
  const fromChallenge = await probeResourceMetadataUrl(mcpUrl)
  if (fromChallenge) candidates.push(fromChallenge)
  candidates.push(defaultProtectedResourceUrl(mcpUrl))

  let resourceMetadata: any = null
  let resource: string | undefined
  for (const url of candidates) {
    try {
      const r = await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, DISCOVERY_TIMEOUT_MS)
      if (r.status === 200 && r.body && typeof r.body === 'object') {
        resourceMetadata = r.body
        resource = r.body.resource
        break
      }
    } catch { /* try next */ }
  }

  const authServers: string[] = resourceMetadata?.authorization_servers
    ?? [new URL(mcpUrl).origin]

  let lastErr = ''
  for (const issuer of authServers) {
    const metadata = await fetchAuthorizationServerMetadata(issuer)
    if (metadata) {
      return {
        resource,
        authorizationServer: issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint,
        revocationEndpoint: metadata.revocation_endpoint,
        scopesSupported: metadata.scopes_supported
      }
    }
    lastErr = `No metadata at ${issuer}`
  }

  throw new Error(`Could not discover OAuth metadata for ${mcpUrl}: ${lastErr || 'no authorization servers found'}`)
}

async function fetchAuthorizationServerMetadata(issuer: string): Promise<any | null> {
  const trimmed = issuer.replace(/\/$/, '')
  // RFC 8414 §3.1 — try authorization-server and openid-configuration endpoints,
  // both at root and at the issuer path.
  const candidates = [
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${trimmed}/.well-known/openid-configuration`
  ]
  // If issuer has a path, also try root variants of the same well-knowns
  try {
    const u = new URL(trimmed)
    if (u.pathname && u.pathname !== '/') {
      candidates.push(`${u.origin}/.well-known/oauth-authorization-server${u.pathname}`)
      candidates.push(`${u.origin}/.well-known/openid-configuration${u.pathname}`)
    }
  } catch { /* ignore */ }

  for (const url of candidates) {
    try {
      const r = await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, DISCOVERY_TIMEOUT_MS)
      if (r.status === 200 && r.body && typeof r.body === 'object' && r.body.token_endpoint && r.body.authorization_endpoint) {
        return r.body
      }
    } catch { /* try next */ }
  }
  return null
}

/**
 * Dynamic Client Registration (RFC 7591). If the auth server doesn't support it, the caller must
 * supply a client_id another way (currently unimplemented — surfaces as an error).
 */
export async function registerOAuthClient(
  metadata: McpOAuthMetadata,
  redirectUri: string,
  clientName: string
): Promise<McpOAuthClient> {
  if (!metadata.registrationEndpoint) {
    throw new Error('Authorization server does not advertise a registration endpoint and no client_id is configured.')
  }

  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client; PKCE only
    application_type: 'web'
  }

  const r = await fetchJson(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  }, DISCOVERY_TIMEOUT_MS)

  if (r.status < 200 || r.status >= 300 || !r.body?.client_id) {
    const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    throw new Error(`Dynamic client registration failed (${r.status}): ${detail}`)
  }

  return {
    clientId: r.body.client_id,
    clientSecret: r.body.client_secret,
    redirectUri,
    registrationAccessToken: r.body.registration_access_token,
    registrationClientUri: r.body.registration_client_uri
  }
}

export interface PkcePair {
  codeVerifier: string
  codeChallenge: string
}

export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function randomState(): string {
  return randomBytes(24).toString('base64url')
}

export function buildAuthorizationUrl(
  metadata: McpOAuthMetadata,
  client: McpOAuthClient,
  state: string,
  codeChallenge: string,
  scope?: string
): string {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', client.redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const requested = scope ?? client.scope ?? metadata.scopesSupported?.join(' ')
  if (requested) url.searchParams.set('scope', requested)
  if (metadata.resource) url.searchParams.set('resource', metadata.resource)
  return url.toString()
}

export async function exchangeCodeForTokens(
  metadata: McpOAuthMetadata,
  client: McpOAuthClient,
  code: string,
  codeVerifier: string
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier
  })
  if (metadata.resource) body.set('resource', metadata.resource)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  }
  if (client.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')
  }

  const r = await fetchJson(metadata.tokenEndpoint, { method: 'POST', headers, body: body.toString() }, TOKEN_TIMEOUT_MS)
  if (r.status < 200 || r.status >= 300 || !r.body?.access_token) {
    const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    throw new Error(`Token exchange failed (${r.status}): ${detail}`)
  }
  return normalizeTokenResponse(r.body)
}

export async function refreshTokens(
  metadata: McpOAuthMetadata,
  client: McpOAuthClient,
  refreshToken: string
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId
  })
  if (metadata.resource) body.set('resource', metadata.resource)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  }
  if (client.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')
  }

  const r = await fetchJson(metadata.tokenEndpoint, { method: 'POST', headers, body: body.toString() }, TOKEN_TIMEOUT_MS)
  if (r.status < 200 || r.status >= 300 || !r.body?.access_token) {
    const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    throw new Error(`Token refresh failed (${r.status}): ${detail}`)
  }
  const next = normalizeTokenResponse(r.body)
  // The server may omit a new refresh_token; keep the old one in that case.
  if (!next.refreshToken) next.refreshToken = refreshToken
  return next
}

function normalizeTokenResponse(body: any): McpOAuthTokens {
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    tokenType: body.token_type ?? 'Bearer',
    scope: body.scope,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
  }
}

export function isAccessTokenExpired(tokens: McpOAuthTokens): boolean {
  if (!tokens.expiresAt) return false
  return Date.now() + REFRESH_SKEW_SEC * 1000 >= tokens.expiresAt
}

/**
 * Ensure the config's tokens are usable for an MCP request. Refreshes in-place if expired
 * and a refresh_token is available. Returns the (possibly updated) tokens, or null if not
 * authenticated yet.
 */
export async function ensureFreshTokens(config: McpServerConfig): Promise<McpOAuthTokens | null> {
  const oauth = config.oauth
  if (!oauth?.tokens) return null
  if (!isAccessTokenExpired(oauth.tokens)) return oauth.tokens
  if (!oauth.tokens.refreshToken || !oauth.metadata || !oauth.client) {
    // Expired and no way to refresh — caller should re-authenticate.
    return oauth.tokens
  }
  const refreshed = await refreshTokens(oauth.metadata, oauth.client, oauth.tokens.refreshToken)
  oauth.tokens = refreshed
  return refreshed
}

// ---------------------------------------------------------------------------
// Pending-authorization state (short-lived, in-memory, per-process)
// ---------------------------------------------------------------------------

interface PendingAuth {
  serverId: string
  orgId: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000
const pending = new Map<string, PendingAuth>()

export function rememberPending(state: string, entry: Omit<PendingAuth, 'createdAt'>): void {
  pruneExpired()
  pending.set(state, { ...entry, createdAt: Date.now() })
}

export function consumePending(state: string): PendingAuth | null {
  pruneExpired()
  const entry = pending.get(state)
  if (!entry) return null
  pending.delete(state)
  return entry
}

function pruneExpired() {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [k, v] of pending) {
    if (v.createdAt < cutoff) pending.delete(k)
  }
}
