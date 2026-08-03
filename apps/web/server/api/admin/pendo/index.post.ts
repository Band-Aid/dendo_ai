import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { pendoSettingsSchema } from '~/server/utils/schemas'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = await readBody(event)
  const parsed = pendoSettingsSchema.parse(body)

  const state = await readAdminState(orgId)
  state.pendo = {
    // The form posts an EMPTY string when the user saves without re-typing the
    // key (it's redacted client-side), and '' is not nullish — a bare `??`
    // merge silently wipes the stored key. Blank means "keep what's saved".
    integrationKey: parsed.integrationKey?.trim() || state.pendo.integrationKey,
    apiEndpoint: parsed.apiEndpoint?.trim() || state.pendo.apiEndpoint,
    defaultAppId: parsed.defaultAppId ?? state.pendo.defaultAppId
  }

  await writeAdminState(state, orgId)
  return { ok: true }
})
