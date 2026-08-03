import type { McpServerConfig, McpTool } from '~/types/mcp'
import { ensureFreshTokens } from '~/server/utils/mcpOAuth'

const TIMEOUT_MS = 15_000

/**
 * Streamable-HTTP MCP servers (e.g. Pendo's /mcp/v0/shttp) are session-based:
 * every request after `initialize` must echo the `mcp-session-id` response
 * header or the server rejects it ("Invalid session ID"). Sessions are cached
 * per server here; configs are re-read from the admin store on every call, so
 * the cache can't live on the config object itself.
 */
interface McpSession {
  id?: string
  protocolVersion?: string
}
const sessions = new Map<string, McpSession>()
const sessionKey = (config: McpServerConfig) => `${config.id}|${config.url}`

async function fetchWithTimeout(url: string, options: RequestInit, ms = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build base headers including a Bearer token if the server is OAuth-authenticated.
 * Refreshes the token in-place when it has expired and a refresh token is available.
 * (Callers that hold the admin state should persist it afterwards so a rotated
 * refresh token isn't lost.)
 */
async function authHeaders(config: McpServerConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable-HTTP servers require the SSE accept alongside JSON.
    Accept: 'application/json, text/event-stream'
  }
  try {
    const tokens = await ensureFreshTokens(config)
    if (tokens?.accessToken) {
      headers.Authorization = `${tokens.tokenType || 'Bearer'} ${tokens.accessToken}`
    }
  } catch (err: any) {
    // Refresh failed — record it so the UI can prompt re-auth, but try the request anyway
    // so the server can return its own 401 with diagnostic detail.
    if (config.oauth) config.oauth.lastError = `Token refresh failed: ${err.message}`
  }
  return headers
}

function markNeedsAuth(config: McpServerConfig, resp: Response) {
  if (resp.status !== 401) return
  if (!config.oauth) config.oauth = {}
  config.oauth.needsAuth = true
  // RFC 9728 — capture the resource_metadata URL for later use if present.
  const challenge = resp.headers.get('www-authenticate')
  if (challenge && !config.oauth.lastError) config.oauth.lastError = `Server requires authentication: ${challenge}`
}

/** Last JSON object delivered across the SSE events of a streamable response. */
function parseSse(text: string): any {
  let last: any = null
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      const obj = JSON.parse(data)
      if (obj && typeof obj === 'object') last = obj
    } catch { /* keep scanning */ }
  }
  return last
}

async function parseRpcResponse(resp: Response): Promise<any> {
  const text = await resp.text()
  if (!text) return null
  if ((resp.headers.get('content-type') || '').includes('text/event-stream')) {
    return parseSse(text)
  }
  try { return JSON.parse(text) } catch { return null }
}

interface RpcResult {
  resp: Response
  json: any
}

async function rpc(
  config: McpServerConfig,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  session?: McpSession
): Promise<RpcResult> {
  const requestHeaders = { ...headers }
  if (session?.id) requestHeaders['mcp-session-id'] = session.id
  if (session?.protocolVersion) requestHeaders['MCP-Protocol-Version'] = session.protocolVersion
  const resp = await fetchWithTimeout(config.url.replace(/\/$/, ''), {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(payload)
  })
  const json = await parseRpcResponse(resp)
  return { resp, json }
}

/**
 * Run the MCP initialize handshake and cache the resulting session. Stateless
 * servers simply don't return a session header — that's fine, the cached
 * session is then empty and later requests carry no session id.
 */
async function establishSession(
  config: McpServerConfig,
  headers: Record<string, string>
): Promise<McpSession> {
  const { resp, json } = await rpc(config, headers, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dendo', version: '0.1' }
    }
  })
  if (resp.status === 401) {
    markNeedsAuth(config, resp)
    throw new Error('Authentication required (401)')
  }
  if (!resp.ok || json?.error) {
    // Not necessarily fatal — plain JSON-RPC shims may skip `initialize` yet
    // still answer tools/list. Cache an empty session and let the actual
    // request produce the authoritative error.
    const empty: McpSession = {}
    sessions.set(sessionKey(config), empty)
    return empty
  }
  const session: McpSession = {
    id: resp.headers.get('mcp-session-id') ?? undefined,
    protocolVersion: json?.result?.protocolVersion
  }
  sessions.set(sessionKey(config), session)
  // Spec-required notification; some servers (Pendo included) tolerate its
  // absence, so failures here are non-fatal.
  try {
    await rpc(config, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  } catch { /* best effort */ }
  return session
}

/**
 * Send one JSON-RPC request with session handling: reuse the cached session,
 * establish one on first contact, and re-initialize once if the server says
 * the session went stale (expiry, server restart).
 */
async function sessionRpc(
  config: McpServerConfig,
  headers: Record<string, string>,
  payload: Record<string, unknown>
): Promise<RpcResult> {
  let session = sessions.get(sessionKey(config)) ?? await establishSession(config, headers)
  let out = await rpc(config, headers, payload, session)
  const sessionStale =
    !out.resp.ok && out.resp.status !== 401
    && (out.resp.status === 404 || out.resp.status === 400)
  if (sessionStale) {
    sessions.delete(sessionKey(config))
    session = await establishSession(config, headers)
    out = await rpc(config, headers, payload, session)
  }
  if (out.resp.status === 401) {
    markNeedsAuth(config, out.resp)
    throw new Error('Authentication required (401)')
  }
  return out
}

export async function loadMcpTools(configs: McpServerConfig[]): Promise<McpTool[]> {
  const all: McpTool[] = []

  for (const config of configs) {
    if (!config.enabled) continue
    try {
      const tools = await loadToolsFromServer(config)
      config.cachedTools = tools
      config.lastConnectedAt = new Date().toISOString()
      if (config.oauth) {
        config.oauth.needsAuth = false
        config.oauth.lastError = undefined
      }
      all.push(...tools)
    } catch (err: any) {
      console.warn(`[mcpClient] Failed to load tools from "${config.name}": ${err.message}`)
      if (config.cachedTools?.length) {
        // Fall back to cached tools
        all.push(...config.cachedTools)
      }
    }
  }

  return all
}

export async function loadToolsFromServer(config: McpServerConfig): Promise<McpTool[]> {
  const headers = await authHeaders(config)

  // MCP JSON-RPC (streamable HTTP or plain) with session handshake.
  let rpcError: string | undefined
  try {
    const { resp, json } = await sessionRpc(config, headers, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
    })
    if (resp.ok && json?.result?.tools) {
      return normalizeMcpTools(json.result.tools)
    }
    rpcError = json?.error?.message ?? `HTTP ${resp.status}`
  } catch (err: any) {
    if (err?.message?.startsWith('Authentication required')) throw err
    rpcError = err?.message
  }

  // Try REST-style GET /tools endpoint (non-MCP fallback)
  try {
    const resp = await fetchWithTimeout(`${config.url.replace(/\/$/, '')}/tools`, { method: 'GET', headers })
    if (resp.ok) {
      const json = await resp.json() as any
      const list = Array.isArray(json) ? json : (json.tools ?? [])
      return normalizeMcpTools(list)
    } else if (resp.status === 401) {
      markNeedsAuth(config, resp)
      throw new Error('Authentication required (401)')
    }
  } catch (err: any) {
    if (err?.message?.startsWith('Authentication required')) throw err
    // fall through
  }

  throw new Error(`Could not load tools from MCP server at ${config.url}${rpcError ? ` (${rpcError})` : ''}`)
}

function normalizeMcpTools(raw: any[]): McpTool[] {
  return raw.map(t => ({
    name: String(t.name ?? ''),
    description: String(t.description ?? ''),
    inputSchema: t.inputSchema ?? t.input_schema ?? t.parameters ?? { type: 'object', properties: {} }
  })).filter(t => t.name)
}

export async function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const headers = await authHeaders(config)

  // MCP JSON-RPC with session handling.
  try {
    const { resp, json } = await sessionRpc(config, headers, {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
    if (resp.ok && json) {
      if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error))
      return json.result
    }
  } catch (err: any) {
    if (err?.message?.startsWith('Authentication required')) {
      throw new Error(`MCP tool call requires authentication for "${config.name}". Re-authenticate from Admin → MCP Servers.`)
    }
    throw err
  }

  // Try REST-style POST /call (non-MCP fallback)
  const resp = await fetchWithTimeout(`${config.url.replace(/\/$/, '')}/call`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: toolName, arguments: args })
  })

  if (!resp.ok) {
    if (resp.status === 401) {
      markNeedsAuth(config, resp)
      throw new Error(`MCP tool call requires authentication for "${config.name}".`)
    }
    const text = await resp.text()
    throw new Error(`MCP tool call failed: ${resp.status} ${text}`)
  }

  return resp.json()
}
