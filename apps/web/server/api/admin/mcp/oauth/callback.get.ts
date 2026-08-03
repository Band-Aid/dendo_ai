import { getQuery } from 'h3'
import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { consumePending, exchangeCodeForTokens } from '~/server/utils/mcpOAuth'

function renderResultPage(ok: boolean, detail: string, serverName: string): string {
  const safe = (s: string) => s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]!))
  const title = ok ? 'MCP authentication complete' : 'MCP authentication failed'
  const color = ok ? '#16a34a' : '#dc2626'
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${safe(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 32px; color: #1f2937; }
  .card { max-width: 480px; margin: 40px auto; padding: 28px 32px; border: 1px solid #e5e7eb; border-radius: 12px; }
  h1 { color: ${color}; margin: 0 0 12px; font-size: 18px; }
  p { margin: 8px 0; font-size: 14px; line-height: 1.5; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .hint { color: #6b7280; font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <h1>${safe(title)}</h1>
    <p>Server: <code>${safe(serverName)}</code></p>
    <p>${safe(detail)}</p>
    <p class="hint">You can close this window.</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ source: 'dendo-mcp-oauth', ok: ${ok ? 'true' : 'false'} }, '*');
      }
    } catch (e) {}
    setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);
  </script>
</body></html>`
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const stateParam = String(q.state || '')
  const code = String(q.code || '')
  const errorParam = q.error ? String(q.error) : ''

  if (!stateParam) {
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, 'Missing state parameter from authorization server.', '')
  }

  const pending = consumePending(stateParam)
  if (!pending) {
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, 'Authorization request expired or already used. Please retry from Admin → MCP Servers.', '')
  }

  const state = await readAdminState(pending.orgId)
  const server = (state.mcpServers ?? []).find(s => s.id === pending.serverId)
  if (!server || !server.oauth?.metadata || !server.oauth?.client) {
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, 'Server configuration is missing or was modified during authentication.', server?.name || '')
  }

  if (errorParam) {
    const detail = `Authorization server reported: ${errorParam}${q.error_description ? ` — ${q.error_description}` : ''}`
    server.oauth.lastError = detail
    server.oauth.needsAuth = true
    await writeAdminState(state, pending.orgId)
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, detail, server.name)
  }

  if (!code) {
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, 'No authorization code was returned.', server.name)
  }

  try {
    const tokens = await exchangeCodeForTokens(server.oauth.metadata, server.oauth.client, code, pending.codeVerifier)
    server.oauth.tokens = tokens
    server.oauth.needsAuth = false
    server.oauth.lastError = undefined
    await writeAdminState(state, pending.orgId)
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(true, 'Tokens stored. The agent can now call this server\'s tools.', server.name)
  } catch (err: any) {
    server.oauth.lastError = err.message || String(err)
    server.oauth.needsAuth = true
    await writeAdminState(state, pending.orgId)
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return renderResultPage(false, server.oauth.lastError, server.name)
  }
})
