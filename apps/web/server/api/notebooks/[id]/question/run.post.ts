import { z } from 'zod'
import { getNotebook } from '~/server/utils/notebookStore'
import { readAdminState } from '~/server/utils/adminStore'
import { buildSystemPrompt, ensureLayer1Loaded } from '~/server/utils/systemPrompt'
import { buildOntologyDigest } from '~/server/utils/ontologyDigest'
import { buildAllTools } from '~/server/utils/toolRegistry'
import { runAgentLoop } from '~/server/utils/agentLoop'
import { withAgentTurn, resolveTurnIdentity } from '~/server/utils/pendoTracing'
import { abortSession } from '~/server/utils/aggregation'
import type { ChatAggregation } from '~/server/utils/chatMessageStore'

const schema = z.object({
  question: z.string().min(1).max(8000),
  /** Cells the question should treat as context — same semantics as chat. */
  referencedCellIds: z.array(z.string()).optional().default([]),
  /** Set when this question cell was created from a concept's cause/action/KPI
   *  on the Product map — forces that concept's full context into the digest. */
  originConceptId: z.string().optional()
})

/**
 * Re-run a saved question cell. This re-asks the agent with the cell's prompt
 * and returns the regenerated answer + every aggregation/summary chart it
 * produced — without touching the chat history. Unlike the chat stream, each
 * run is stateless (fresh, single-turn conversation) so the same question
 * yields a clean, reproducible answer no matter how many times it's run.
 */
export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const notebookId = getRouterParam(event, 'id')!
  const body = await readBody(event)

  let input: z.infer<typeof schema>
  try {
    input = schema.parse(body)
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  const { question, referencedCellIds, originConceptId } = input

  let notebook: Awaited<ReturnType<typeof getNotebook>>
  try {
    notebook = getNotebook(notebookId, orgId)
  } catch {
    throw createError({ statusCode: 404, message: 'Notebook not found' })
  }

  const state = await readAdminState(orgId)
  const enabledAgents = state.agents.filter(a => a.enabled)
  if (!enabledAgents.length) {
    throw createError({ statusCode: 400, message: 'No agents configured. Please configure an agent in Admin.' })
  }
  const agent = enabledAgents[0]

  const provider = state.providers.find(p => p.provider === agent.provider && p.enabled)
  if (!provider?.apiKey) {
    throw createError({ statusCode: 400, message: `Provider "${agent.provider}" not configured or API key missing.` })
  }

  const appId = state.pendo?.defaultAppId ?? -323232

  await ensureLayer1Loaded()

  const referencedCells = referencedCellIds.length
    ? notebook.cells.filter(c => referencedCellIds.includes(c.id))
    : []

  const systemPrompt = await buildSystemPrompt({
    notebookTitle: notebook.title,
    cells: notebook.cells,
    appId,
    referencedCells,
    agentSystemPrompt: agent.systemPrompt || undefined,
    agentInstructions: state.settings?.agentInstructions || undefined,
    customSkills: state.settings?.customSkills,
    ontologyDigest: buildOntologyDigest(orgId, originConceptId) ?? undefined,
    defaultSegmentId: notebook.default_segment_id ?? null,
    defaultSegmentName: notebook.default_segment_name ?? null,
    defaultAccountId: notebook.default_account_id ?? null
  })

  const { builtIn, mcp, mcpConfigs } = await buildAllTools(orgId)
  const allTools = [...builtIn, ...mcp]

  // Stateless, single-turn session id — never reused, so re-running a question
  // can never inherit or pollute earlier conversation state.
  const sessionId = `qcell-${notebookId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Each run is a deliberately stateless single turn, so the run's own session
  // id is also its Pendo conversation id.
  const identity = resolveTurnIdentity(event, orgId)

  try {
    const result = await withAgentTurn(
      {
        orgId,
        conversationId: `qcell:${sessionId}`,
        prompt: question,
        visitorId: identity.visitorId,
        accountId: identity.accountId,
        eventProperties: {
          surface: 'question-cell-run',
          notebookId,
          ...(originConceptId ? { originConceptId } : {})
        }
      },
      () => runAgentLoop({
        provider,
        model: agent.model,
        systemPrompt,
        messages: [{ role: 'user', content: question }],
        tools: allTools,
        maxTokens: state.settings?.maxTokens ?? 4096,
        orgId,
        sessionId,
        mcpConfigs,
        defaultSegmentId: notebook.default_segment_id ?? null,
        defaultAccountId: notebook.default_account_id ?? null,
        // Non-streaming endpoint — the callbacks are required by the loop but we
        // only care about the final, structured result here.
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onDone: () => {}
      }),
      (r) => r.textContent
    )

    const aggregations: ChatAggregation[] = result.aggregationResults.map(r => ({
      dsl: r.dsl,
      rows: r.rows,
      columns: r.columns,
      explanation: r.explanation
    }))

    return {
      answer: result.textContent,
      aggregations,
      summaryCharts: result.summaryCharts,
      runAt: new Date().toISOString()
    }
  } catch (err: any) {
    abortSession(sessionId)
    throw createError({ statusCode: 500, message: err.message || 'Agent error' })
  }
})
