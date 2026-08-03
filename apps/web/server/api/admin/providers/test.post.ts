import { providerSchema } from '~/server/utils/schemas'
import { validateProviderConfig } from '~/server/utils/providerValidation'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = providerSchema.parse(body)
  const validation = validateProviderConfig(parsed)

  if (!validation.ok) {
    throw createError({ statusCode: 400, statusMessage: validation.reason })
  }

  return { ok: true, message: 'Configuration validated.' }
})
