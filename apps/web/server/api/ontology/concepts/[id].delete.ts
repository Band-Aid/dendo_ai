import { deleteConcept } from '~/server/utils/ontologyStore'

export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const id = getRouterParam(event, 'id')!
  const removed = deleteConcept(orgId, id)
  if (!removed) throw createError({ statusCode: 404, message: 'Concept not found' })
  return { ok: true }
})
