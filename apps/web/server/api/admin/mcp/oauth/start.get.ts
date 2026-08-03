import { getRequestProtocol, getRequestHost, getQuery } from 'h3'
import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import {
  discoverOAuthMetadata,
  registerOAuthClient,
  generatePkce,
  randomState,
  buildAuthorizationUrl,
  rememberPending
} from '~/server/utils/mcpOAuth'

function renderErrorPage(detail: string, serverName: string): string {
  const safe = (s: string) => s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]!))
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>MCP authentication failed</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 32px; color: #1f2937; }
  .card { max-width: 480px; margin: 40px auto; padding: 28px 32px; border: 1px solid #e5e7eb; border-radius: 12px; }
  h1 { color: #dc2626; margin: 0 0 12px; font-size: 18px; }
  p { margin: 8px 0; font-size: 14px; line-height: 1.5; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .hint { color: #6b7280; font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <h1>MCP authentication failed</h1>
    <p>Server: <code>${safe(serverName)}</code></p>
    <p>${safe(detail)}</p>
    <p class="hint">You can close this window.</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ source: 'dendo-mcp-oauth', ok: false }, '*');
      }
    } catch (e) {}
    setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
  </script>
</body></html>`
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  // This endpoint is reached by a popup NAVIGATION, which can't carry the
  // x-org-id header the rest of the admin API uses — so orgId arrives as a
  // query param (header kept as a fallback for direct API callers).
  const orgId = String(q.orgId || '') || getHeader(event, 'x-org-id') || 'default'
  const serverId = String(q.serverId || '')
  if (!serverId) throw createError({ statusCode: 400, message: 'serverId is required' })

  const state = await readAdminState(orgId)
  const server = (state.mcpServers ?? []).find(s => s.id === serverId)
  if (!server) {
    // Render the same HTML error page as auth failures — a thrown 404 would
    // show raw JSON in the popup and never postMessage the opener, leaving
    // the admin page waiting forever.
    setResponseStatus(event, 404)
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderErrorPage('MCP server not found in saved settings. Save your server configuration, then try authenticating again.', serverId)
  }

  const protocol = getRequestProtocol(event)
  const host = getRequestHost(event)
  const redirectUri = `${protocol}://${host}/api/admin/mcp/oauth/callback`

  try {
    let metadata = server.oauth?.metadata
    if (!metadata || String(q.rediscover) === 'true') {
      metadata = await discoverOAuthMetadata(server.url)
    }

    let client = server.oauth?.client
    // Re-register if the redirect URI changed (e.g., dev port shifted) or no client yet.
    if (!client || client.redirectUri !== redirectUri) {
      client = await registerOAuthClient(metadata, redirectUri, `Dendo (${server.name})`)
    }

    const { codeVerifier, codeChallenge } = generatePkce()
    const stateParam = randomState()
    rememberPending(stateParam, { serverId, orgId, codeVerifier, redirectUri })

    // Persist discovered metadata + client so callback can complete the exchange.
    server.oauth = {
      ...(server.oauth ?? {}),
      metadata,
      client,
      needsAuth: server.oauth?.needsAuth,
      lastError: undefined
    }
    await writeAdminState(state, orgId)

    const authUrl = buildAuthorizationUrl(metadata, client, stateParam, codeChallenge)
    await sendRedirect(event, authUrl, 302)
  } catch (err: any) {
    const detail = err?.message || String(err)
    if (server.oauth) {
      server.oauth.lastError = detail
      server.oauth.needsAuth = true
      await writeAdminState(state, orgId)
    } else {
      server.oauth = { lastError: detail, needsAuth: true }
      await writeAdminState(state, orgId)
    }
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderErrorPage(detail, server.name)
  }
})
