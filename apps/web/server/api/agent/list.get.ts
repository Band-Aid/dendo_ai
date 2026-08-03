import { readAdminState } from '~/server/utils/adminStore'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const state = await readAdminState(orgId)
  
  // Return only enabled agents with their model info
  const agents = state.agents
    .filter(a => a.enabled)
    .map(a => {
      const provider = state.providers.find(p => p.provider === a.provider)
      return {
        id: a.id,
        name: a.name,
        purpose: a.purpose,
        provider: a.provider,
        model: a.model,
        providerEnabled: provider?.enabled || false
      }
    })
  
  return { agents }
})
