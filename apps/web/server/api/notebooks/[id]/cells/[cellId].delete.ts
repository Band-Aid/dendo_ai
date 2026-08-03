import { deleteCell } from '~/server/utils/notebookStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  const cellId = getRouterParam(event, 'cellId')!
  deleteCell(cellId, id, orgId)
  return { success: true }
})
