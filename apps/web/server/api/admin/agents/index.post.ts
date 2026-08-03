import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { agentSchema } from '~/server/utils/schemas'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = await readBody(event)
  const parsed = agentSchema.parse(body)

  const state = await readAdminState(orgId)
  const idx = state.agents.findIndex((a) => a.id === parsed.id)
  if (idx === -1) state.agents.push(parsed)
  else state.agents[idx] = parsed

  await writeAdminState(state, orgId)
  return { ok: true }
})
