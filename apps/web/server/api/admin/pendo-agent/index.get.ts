import { readAdminState } from '~/server/utils/adminStore'
import { isPendoTracingEnabled, loadPendoAgentConfig } from '~/server/utils/pendoTracing'

/**
 * Current Agent Analytics settings, plus what is actually in effect.
 *
 * `effective` matters because the saved settings are not the whole story: a
 * deployment can supply `PENDO_AGENT_*` env vars, and with nothing saved those
 * are what the app reports under. Showing only the (empty) saved form would
 * read as "tracing is off" while conversations were still being exported.
 *
 * No masking — `apiKey` is a Pendo Public App ID, the same value a browser
 * snippet exposes, and being able to read it back is how you confirm which
 * subscription you are reporting into.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const [state, effective] = await Promise.all([
    readAdminState(orgId),
    loadPendoAgentConfig(orgId)
  ])

  return {
    saved: state.pendoAgent ?? null,
    effective: {
      enabled: effective.enabled,
      apiKey: effective.apiKey,
      agentId: effective.agentId,
      endpoint: effective.endpoint,
      redact: effective.redact
    },
    /** True when nothing is saved but env vars are supplying a destination. */
    fromEnvironment:
      !state.pendoAgent?.apiKey?.trim() &&
      effective.enabled !== false &&
      !!effective.apiKey.trim() &&
      !!effective.agentId.trim(),
  }
})
