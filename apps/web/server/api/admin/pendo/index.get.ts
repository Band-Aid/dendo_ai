import { readAdminState, maskPendoSecrets } from '~/server/utils/adminStore'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const state = await readAdminState(orgId)
  return maskPendoSecrets(state.pendo)
})
