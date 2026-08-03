import { z } from 'zod'
import { readAdminState, writeAdminState } from '~/server/utils/adminStore'

const schema = z.object({
  id: z.string().min(1)
})

/**
 * Delete an agent profile. The Admin UI has always sent DELETE with {id} —
 * this handler just never existed, so deletes surfaced as a raw framework
 * error page instead of removing anything.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  let input: z.infer<typeof schema>
  try {
    input = schema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  const state = await readAdminState(orgId)
  const before = state.agents.length
  state.agents = state.agents.filter(a => a.id !== input.id)
  if (state.agents.length === before) {
    throw createError({ statusCode: 404, message: 'Agent not found' })
  }

  await writeAdminState(state, orgId)
  return { ok: true }
})
