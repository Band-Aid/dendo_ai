import { deleteWorkspace } from '~/server/utils/workspaceStore'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing workspace id' })
  }

  const orgId = event.context.orgId as string
  const deleted = deleteWorkspace(id, orgId)
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { success: true, id }
})
