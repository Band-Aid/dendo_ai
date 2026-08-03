import { z } from 'zod'
import { createWorkspace } from '~/server/utils/workspaceStore'

const bodySchema = z.object({
  title: z.string().optional().default(''),
  decisionQuestion: z.string().optional().default('')
})

function toAutoTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, ' ').replace(/\?+$/, '')
  if (cleaned.length <= 90) return cleaned
  return `${cleaned.slice(0, 87)}...`
}

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const body = bodySchema.parse(await readBody(event))

  const seed = body.decisionQuestion.trim() || 'Untitled exploration'
  const title = body.title.trim() || toAutoTitle(seed)

  const workspace = createWorkspace({
    title,
    decisionQuestion: seed,
    goalType: 'revenue',
    primarySuccessMetric: '',
    orgId
  })
  return { workspace }
})
