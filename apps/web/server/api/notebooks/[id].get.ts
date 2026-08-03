import { getNotebook } from '~/server/utils/notebookStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  return getNotebook(id, orgId)
})
