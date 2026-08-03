import { z } from 'zod'
import { readAdminState, writeAdminState, mergeMcpServer, maskMcpServer } from '~/server/utils/adminStore'
import type { McpServerConfig } from '~/types/mcp'

const serverSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  transport: z.literal('http_sse'),
  url: z.string().url(),
  enabled: z.boolean()
}).passthrough()

const schema = z.object({
  servers: z.array(serverSchema)
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const body = await readBody(event)
  const input = schema.parse(body)
  const state = await readAdminState(orgId)

  const existingById = new Map((state.mcpServers ?? []).map(s => [s.id, s]))
  state.mcpServers = input.servers.map(s => mergeMcpServer(s as McpServerConfig, existingById.get(s.id)))

  await writeAdminState(state, orgId)
  return state.mcpServers.map(maskMcpServer)
})
