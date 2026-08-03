import { transitionWorkspaceState, type WorkspaceState } from '~/server/utils/workspaceStore'

const VALID_STATES = ['framing', 'learning', 'deciding'] as const

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing workspace id' })
  }

  const orgId = event.context.orgId as string
  const body = await readBody(event)
  const targetState = body?.state as string

  if (!targetState || !VALID_STATES.includes(targetState as WorkspaceState)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid state: "${targetState}". Must be one of: ${VALID_STATES.join(', ')}`
    })
  }

  try {
    const workspace = transitionWorkspaceState(id, targetState as WorkspaceState, orgId)
    if (!workspace) {
      throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
    }
    return { workspace }
  } catch (err: any) {
    if (err.message?.includes('Invalid state transition')) {
      throw createError({ statusCode: 422, statusMessage: err.message })
    }
    throw err
  }
})
