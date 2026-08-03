import { compileSchema } from '~/server/utils/schemas'
import { compileDsl } from '~/server/utils/aggregation'
import { getNotebook } from '~/server/utils/notebookStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const body = await readBody(event)
  const parsed = compileSchema.parse(body)

  let defaultSegmentId: string | null = null
  if (parsed.notebookId) {
    try {
      const nb = getNotebook(parsed.notebookId, orgId)
      defaultSegmentId = nb.default_segment_id ?? null
    } catch {
      // Notebook not found / cross-org — fall through with no default segment.
    }
  }

  return await compileDsl(parsed.dsl, undefined, { defaultSegmentId })
})
