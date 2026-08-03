import { deleteNotebookCell } from '~/server/utils/workspaceStore'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const cellId = getRouterParam(event, 'cellId')

  if (!id || !cellId) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id and cell id are required' })
  }

  const orgId = event.context.orgId as string
  const workspace = deleteNotebookCell(id, cellId, orgId)

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { workspace }
})