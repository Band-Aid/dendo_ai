import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { verifyPendoKey } from '~/server/utils/pendoEntities'

const schema = z.object({
  /** Key to test before saving; blank/absent → test the stored key. */
  integrationKey: z.string().optional()
})

/**
 * Real round-trip validation of the Pendo integration key via GET
 * /token/verify (per the Pendo OpenAPI spec). Catches invalid or wiped keys
 * at config time instead of at the first failing sync/aggregation.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = await readBody(event).catch(() => ({}))
  const input = schema.parse(body ?? {})

  const key = input.integrationKey?.trim() || (await readAdminState(orgId)).pendo?.integrationKey
  if (!key) {
    throw createError({ statusCode: 400, message: 'No integration key to test — enter one or save it first.' })
  }

  const result = await verifyPendoKey(key)
  if (!result.valid) {
    throw createError({ statusCode: 400, message: 'Pendo rejected this integration key (HTTP 403). Check it in Pendo → Settings → Integrations.' })
  }
  return { ok: true, valid: true, writeAccess: result.writeAccess ?? false }
})
