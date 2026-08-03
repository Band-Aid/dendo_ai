import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { providerSchema } from '~/server/utils/schemas'
import { validateProviderConfig } from '~/server/utils/providerValidation'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = await readBody(event)
  const parsed = providerSchema.parse(body)

  const state = await readAdminState(orgId)
  const index = state.providers.findIndex((p) => p.provider === parsed.provider)

  const existing = index === -1 ? undefined : state.providers[index]
  // Blank strings mean "keep what's saved" — the form redacts the stored key
  // and posts '' when the user saves without re-typing it, and '' is not
  // nullish, so a bare `??` merge would silently wipe stored secrets.
  const keep = (incoming: string | undefined, saved: string | undefined) =>
    incoming?.trim() ? incoming.trim() : saved
  const nextProvider = {
    provider: parsed.provider,
    enabled: parsed.enabled,
    apiKey: keep(parsed.apiKey, existing?.apiKey),
    endpoint: keep(parsed.endpoint, existing?.endpoint),
    apiVersion: keep(parsed.apiVersion, existing?.apiVersion),
    deployment: keep(parsed.deployment, existing?.deployment)
  }

  const validation = validateProviderConfig(nextProvider)
  if (!validation.ok) {
    throw createError({ statusCode: 400, statusMessage: validation.reason })
  }

  if (index === -1) state.providers.push(nextProvider)
  else state.providers[index] = nextProvider

  await writeAdminState(state, orgId)
  return { ok: true }
})
