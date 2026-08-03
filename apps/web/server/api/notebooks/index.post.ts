import { z } from 'zod'
import { createNotebook } from '~/server/utils/notebookStore'

const schema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional()
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const body = await readBody(event)
  const input = schema.parse(body)
  return createNotebook(orgId, input.title, input.description)
})
