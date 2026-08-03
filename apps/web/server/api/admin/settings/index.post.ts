import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { generalSettingsSchema } from '~/server/utils/schemas'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = await readBody(event)
  const parsed = generalSettingsSchema.parse(body)

  const state = await readAdminState(orgId)
  state.settings = {
    ...state.settings,
    ...(parsed.maxTokens !== undefined && { maxTokens: parsed.maxTokens }),
    // Trim on save so leading/trailing whitespace doesn't persist into the
    // system prompt. Empty strings clear the field.
    ...(parsed.agentInstructions !== undefined && {
      agentInstructions: parsed.agentInstructions.trim()
    }),
    ...(parsed.customSkills !== undefined && {
      customSkills: parsed.customSkills.map(s => ({
        ...s,
        name: s.name.trim(),
        triggers: s.triggers.trim(),
        content: s.content.trim()
      }))
    })
  }

  await writeAdminState(state, orgId)
  return { ok: true }
})
