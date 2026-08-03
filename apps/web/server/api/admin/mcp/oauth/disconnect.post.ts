import { z } from 'zod'
import { readAdminState, writeAdminState, maskMcpServer } from '~/server/utils/adminStore'

const schema = z.object({ serverId: z.string() })

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const body = await readBody(event)
  const input = schema.parse(body)

  const state = await readAdminState(orgId)
  const server = (state.mcpServers ?? []).find(s => s.id === input.serverId)
  if (!server) throw createError({ statusCode: 404, message: 'MCP server not found' })

  if (server.oauth) {
    server.oauth.tokens = undefined
    server.oauth.needsAuth = false
    server.oauth.lastError = undefined
  }
  await writeAdminState(state, orgId)
  return maskMcpServer(server)
})
