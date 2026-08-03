import { z } from 'zod'
import { moveCell } from '~/server/utils/notebookStore'

const schema = z.object({
  after_cell_id: z.string().nullable().default(null)
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  const cellId = getRouterParam(event, 'cellId')!
  const body = await readBody(event)
  const input = schema.parse(body)
  return moveCell(cellId, id, orgId, input.after_cell_id)
})
