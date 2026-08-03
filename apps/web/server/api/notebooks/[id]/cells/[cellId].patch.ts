import { z } from 'zod'
import { updateCell } from '~/server/utils/notebookStore'

const schema = z.object({
  content: z.string().optional(),
  meta_json: z.record(z.unknown()).optional(),
  cell_type: z.string().optional(),
  source_cell_id: z.string().nullable().optional()
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  const cellId = getRouterParam(event, 'cellId')!
  const body = await readBody(event)
  const patch = schema.parse(body)
  return updateCell(cellId, id, orgId, patch)
})
