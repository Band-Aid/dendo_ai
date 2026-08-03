import { z } from 'zod'
import { getRouterParam } from 'h3'
import { appendTimelineStep, createEvidenceCard, getWorkspaceState } from '~/server/utils/workspaceStore'

const bodySchema = z.object({
  stepType: z.enum(['hypothesis', 'data_pull', 'finding', 'refinement', 'analysis_plan']),
  title: z.string().min(1),
  content: z.string().min(1),
  card: z.object({
    question: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.array(z.string()).optional(),
    dataSource: z.array(z.string()).optional()
  }).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id is required' })
  }

  const orgId = event.context.orgId as string
  const state = getWorkspaceState(id, orgId)
  if (!state) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  // In framing state, only allow hypothesis timeline entries (no cards, no data pulls)
  const body = bodySchema.parse(await readBody(event))
  if (state === 'framing' && body.card) {
    throw createError({ statusCode: 422, statusMessage: 'Cannot create evidence cards in framing state. Confirm framing first.' })
  }

  let workspace = appendTimelineStep(id, {
    stepType: body.stepType,
    title: body.title,
    content: body.content
  }, orgId)

  if (workspace && body.card) {
    workspace = createEvidenceCard(id, body.card, orgId)
  }

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { workspace }
})
