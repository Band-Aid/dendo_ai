import { z } from 'zod'
import { addCell } from '~/server/utils/notebookStore'

const schema = z.object({
  cell_type: z.enum(['note', 'query', 'result', 'chart', 'agent_message', 'insight', 'question']),
  content: z.string().default(''),
  meta_json: z.record(z.unknown()).default({}),
  source_cell_id: z.string().nullable().optional(),
  after_cell_id: z.string().nullable().optional()
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const input = schema.parse(body)
  return addCell(id, orgId, input.cell_type, input.content, input.meta_json, input.source_cell_id, input.after_cell_id)
})
