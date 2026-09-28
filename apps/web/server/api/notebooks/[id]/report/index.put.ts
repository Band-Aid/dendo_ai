import { saveReportSchema } from '~/server/utils/reportSchema'
import { saveReport } from '~/server/utils/reportStore'
export default defineEventHandler(async event => {
  const parsed = saveReportSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: parsed.error.issues.map(i => i.message).join('; ') })
  return saveReport(getRouterParam(event, 'id')!, event.context.orgId, parsed.data.config, parsed.data.expectedUpdatedAt)
})
