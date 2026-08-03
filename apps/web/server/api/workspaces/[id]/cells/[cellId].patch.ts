import { z } from 'zod'
import { updateNotebookCell } from '~/server/utils/workspaceStore'

const bodySchema = z.object({
  content: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  type: z.enum(['text', 'query', 'output', 'chart', 'agent_suggestion']).optional(),
  name: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const cellId = getRouterParam(event, 'cellId')

  if (!id || !cellId) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id and cell id are required' })
  }

  const orgId = event.context.orgId as string
  const body = bodySchema.parse(await readBody(event))
  const workspace = updateNotebookCell(id, cellId, body, orgId)

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace or cell not found' })
  }

  return { workspace }
})