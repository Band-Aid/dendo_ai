import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { pendoAgentSettingsSchema } from '~/server/utils/schemas'
import { refreshPendoAgentConfig } from '~/server/utils/pendoTracing'

/**
 * Save the Agent Analytics destination.
 *
 * Unlike the integration key, every field is stored exactly as posted — blanks
 * included. Clearing the Public App ID is how you stop reporting, so treating
 * "" as "keep the old value" would make the destination impossible to remove.
 *
 * The SDK is re-initialised before responding, so the answer reflects what is
 * actually running rather than what was merely written to disk.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  let input: ReturnType<typeof pendoAgentSettingsSchema.parse>
  try {
    input = pendoAgentSettingsSchema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.errors?.[0]?.message ?? err.message })
  }

  const state = await readAdminState(orgId)
  state.pendoAgent = {
    enabled: input.enabled,
    apiKey: input.apiKey.trim(),
    agentId: input.agentId.trim(),
    endpoint: input.endpoint.trim(),
    redact: input.redact,
    defaultVisitorId: input.defaultVisitorId.trim(),
    defaultAccountId: input.defaultAccountId.trim()
  }
  await writeAdminState(state, orgId)

  const tracing = await refreshPendoAgentConfig(orgId)
  return { ok: true, tracing }
})
