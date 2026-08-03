import { z } from 'zod'
import { updateNotebook } from '~/server/utils/notebookStore'

// `transform(s => s?.trim() ?? s)` strips any whitespace (notably trailing
// newlines that leaked in from `lookup_segments.py` stdout in older flows) so a
// segment id never round-trips into the DB with a "\n" suffix that would later
// break aggDSL injection.
const trimNullableString = (max: number) =>
  z.string().max(max).nullable().optional().transform(v => (typeof v === 'string' ? v.trim() : v))

const schema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  default_segment_id: trimNullableString(200),
  default_segment_name: trimNullableString(500)
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const patch = schema.parse(body)
  return updateNotebook(id, orgId, patch)
})
