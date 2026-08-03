import { z } from 'zod'
import { loadToolsFromServer } from '~/server/utils/mcpClient'
import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import type { McpServerConfig } from '~/types/mcp'

const schema = z.object({
  serverId: z.string().optional(),
  url: z.string().url().optional(),
  name: z.string().default('test')
})

/**
 * Connectivity test for one MCP server. When `serverId` matches a saved
 * server, the SAVED config is used so stored OAuth tokens are attached —
 * a synthetic {url} config would probe unauthenticated and read as "0 tools"
 * on any server that requires auth. Falls back to a bare-URL probe for
 * servers that haven't been saved yet.
 */
export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const input = schema.parse(await readBody(event))

  const state = await readAdminState(orgId)
  const saved = input.serverId
    ? (state.mcpServers ?? []).find(s => s.id === input.serverId)
    : undefined

  const config: McpServerConfig = saved ?? {
    id: 'test',
    name: input.name,
    transport: 'http_sse',
    url: input.url ?? '',
    enabled: true
  }
  if (!config.url) {
    return { success: false, error: 'No URL — save the server or provide one.' }
  }

  try {
    const tools = await loadToolsFromServer(config)
    if (saved) {
      // Persist side effects of the probe: rotated/refreshed OAuth tokens and
      // the fresh tool cache the agent falls back on when the server is down.
      saved.cachedTools = tools
      saved.lastConnectedAt = new Date().toISOString()
      if (saved.oauth) {
        saved.oauth.needsAuth = false
        saved.oauth.lastError = undefined
      }
      await writeAdminState(state, orgId)
    }
    return { success: true, toolCount: tools.length, tools }
  } catch (err: any) {
    if (saved) {
      // needsAuth / lastError may have been set on the config by the client.
      await writeAdminState(state, orgId)
    }
    return { success: false, error: err.message }
  }
})
