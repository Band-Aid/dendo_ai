import { z } from 'zod'
import { addNotebookCell } from '~/server/utils/workspaceStore'

const bodySchema = z.object({
  type: z.enum(['text', 'query', 'output', 'chart', 'agent_suggestion']),
  content: z.string(),
  metadata: z.record(z.any()).optional(),
  sourceCellId: z.string().optional(),
  afterCellId: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id is required' })
  }

  const orgId = event.context.orgId as string
  const body = bodySchema.parse(await readBody(event))
  const workspace = addNotebookCell(id, body, orgId)

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { workspace }
})