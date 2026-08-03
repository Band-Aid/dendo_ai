import { z } from 'zod'
import { getRouterParam } from 'h3'
import { updateWorkspaceContext, upsertRecommendation } from '~/server/utils/workspaceStore'

const contextSchema = z.object({
  decisionTitle: z.string().min(1).optional(),
  goalType: z.enum(['revenue', 'roi']).optional(),
  primarySuccessMetric: z.string().optional(),
  status: z.enum(['exploring', 'validating', 'ready_to_act']).optional(),
  confidence: z.enum(['low', 'med', 'high']).optional()
})

const recommendationSchema = z.object({
  proposedAction: z.string(),
  supportingEvidence: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'med', 'high']),
  nextExperiment: z.string()
})

const bodySchema = z.object({
  context: contextSchema.optional(),
  recommendation: recommendationSchema.optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Workspace id is required' })
  }

  const orgId = event.context.orgId as string
  const body = bodySchema.parse(await readBody(event))

  let workspace = null
  if (body.context) {
    workspace = updateWorkspaceContext(id, body.context, orgId)
  }
  if (body.recommendation) {
    workspace = upsertRecommendation(id, body.recommendation, orgId)
  }

  if (!workspace) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }

  return { workspace }
})
