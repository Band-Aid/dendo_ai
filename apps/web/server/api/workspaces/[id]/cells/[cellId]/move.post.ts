import { z } from 'zod'
import { moveNotebookCell } from '~/server/utils/workspaceStore'

const bodySchema = z.object({
  targetCellId: z.string()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const cellId = getRouterParam(event, 'cellId')
  
  if (!id || !cellId) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id and cell id are required' })
  }

  const orgId = event.context.orgId as string
  const body = bodySchema.parse(await readBody(event))
  const workspace = moveNotebookCell(id, cellId, body.targetCellId, orgId)

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace or cell not found' })
  }

  return { workspace }
})
