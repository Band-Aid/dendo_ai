import { getRouterParam } from 'h3'
import { getWorkspaceById } from '~/server/utils/workspaceStore'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id is required' })
  }

  const orgId = event.context.orgId as string
  const workspace = getWorkspaceById(id, orgId)
  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { workspace }
})
