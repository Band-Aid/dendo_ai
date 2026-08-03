import { listWorkspaces } from '~/server/utils/workspaceStore'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  return {
    workspaces: listWorkspaces(orgId)
  }
})
