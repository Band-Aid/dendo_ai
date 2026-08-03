import { readAdminState, maskMcpServer } from '~/server/utils/adminStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const state = await readAdminState(orgId)
  return (state.mcpServers ?? []).map(maskMcpServer)
})
