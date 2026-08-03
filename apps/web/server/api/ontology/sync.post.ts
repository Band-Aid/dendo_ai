import { syncStructural } from '~/server/utils/ontologyBuilder'

/**
 * Rebuild the structural layer from Pendo. Atomic (fetch failure leaves the
 * blob untouched) and concept-preserving — see syncStructural.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const structural = await syncStructural(orgId)
  return {
    ok: true,
    syncedAt: structural.syncedAt,
    counts: structural.counts,
    truncated: structural.truncated,
    appIdMismatch: structural.appIdMismatch
  }
})
