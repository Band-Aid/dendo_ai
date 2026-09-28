import { z } from 'zod'
import { publishReport } from '~/server/utils/reportStore'
export default defineEventHandler(async event => {
  const parsed = z.object({ expectedUpdatedAt: z.string() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Save the report before publishing.' })
  return publishReport(getRouterParam(event, 'id')!, event.context.orgId, parsed.data.expectedUpdatedAt)
})
