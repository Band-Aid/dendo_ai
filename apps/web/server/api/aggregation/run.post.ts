import { runSchema } from '~/server/utils/schemas'
import { runAggregation } from '~/server/utils/aggregation'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = runSchema.parse(body)
  return await runAggregation(parsed.source, parsed.isDsl)
})
