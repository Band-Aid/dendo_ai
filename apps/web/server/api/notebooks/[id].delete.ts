import { deleteNotebook } from '~/server/utils/notebookStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  deleteNotebook(id, orgId)
  return { success: true }
})
