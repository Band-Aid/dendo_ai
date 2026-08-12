import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { buildSystemPrompt, ensureLayer1Loaded } from '~/server/utils/systemPrompt'
import { buildOntologyDigest } from '~/server/utils/ontologyDigest'
import { buildAllTools } from '~/server/utils/toolRegistry'
import { runAgentLoop } from '~/server/utils/agentLoop'
import { withAgentTurn, resolveTurnIdentity } from '~/server/utils/pendoTracing'
import { abortSession } from '~/server/utils/aggregation'
import { evolveConcepts } from '~/server/utils/conceptEvolution'
import { readOntology } from '~/server/utils/ontologyStore'
import type { OntologyBlob } from '~/types/ontology'

const schema = z.object({
  question: z.string().min(1).max(8000),
  /** Map node the question was launched from — seeds the related subgraph. */
  originNodeId: z.string().optional(),
  /** EXPERIMENT ONLY: strips the ontology digest + lookup_ontology tool for an A/B control run. Never set by the UI. */
  noOntology: z.boolean().optional()
})

/**
 * Which map nodes does this question touch? Origin node + its immediate
 * neighborhood (structural edges, concept measures/causes), plus any concept
 * or entity whose name appears in the question text. Drives the graph
 * highlight so the user sees what the question is connected to — including
 * the causes/actions hanging off matched concepts.
 */
function findRelatedNodes(question: string, blob: OntologyBlob, originNodeId?: string): string[] {
  const q = question.toLowerCase()
  const related = new Set<string>()

  const conceptMeasures = new Map(blob.concepts.map(c => [c.id, c.measures]))
  const addConcept = (id: string) => {
    related.add(id)
    for (const m of conceptMeasures.get(id) ?? []) related.add(m)
    for (const c of blob.concepts) {
      for (const cause of c.causes) {
        if (cause.conceptId === id) related.add(c.id)
      }
    }
  }

  if (originNodeId) {
    related.add(originNodeId)
    if (conceptMeasures.has(originNodeId)) addConcept(originNodeId)
    for (const e of blob.structural.edges) {
      if (e.from === originNodeId) related.add(e.to)
      if (e.to === originNodeId) related.add(e.from)
    }
    for (const c of blob.concepts) {
      if (c.measures.includes(originNodeId)) related.add(c.id)
    }
  }

  for (const c of blob.concepts) {
    if (c.name.length >= 3 && q.includes(c.name.toLowerCase())) addConcept(c.id)
  }
  for (const n of blob.structural.nodes) {
    if (n.name.length >= 3 && q.includes(n.name.toLowerCase())) related.add(n.id)
  }

  return [...related].slice(0, 40)
}

function emit(event: any, data: object) {
  event.node.res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * Ask the agent a question directly from the Product map — no notebook
 * required. Same frozen-agent wiring as a question cell's first run, with the
 * ontology digest as the primary context instead of notebook cells.
 *
 * Streams SSE (same event shapes as the notebook agent stream) so the panel
 * shows text and tool activity as the multi-turn loop runs, instead of a
 * blind spinner for the whole run: `related` (immediately — drives the graph
 * highlight), `text` / `tool_start` / `tool_result` / `done`, then one final
 * `result` carrying the full structured payload; persisting to a notebook is
 * the caller's (optional) next step. Config errors still throw plain HTTP
 * errors — they happen before the stream starts.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  let input: z.infer<typeof schema>
  try {
    input = schema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  const state = await readAdminState(orgId)
  const agent = state.agents.filter(a => a.enabled)[0]
  if (!agent) {
    throw createError({ statusCode: 400, message: 'No agents configured. Please configure an agent in Admin.' })
  }
  const provider = state.providers.find(p => p.provider === agent.provider && p.enabled)
  if (!provider?.apiKey) {
    throw createError({ statusCode: 400, message: `Provider "${agent.provider}" not configured or API key missing.` })
  }

  const blob = readOntology(orgId)
  const relatedNodeIds = findRelatedNodes(input.question, blob, input.originNodeId)
  const noOntology = input.noOntology === true

  await ensureLayer1Loaded()
  const systemPrompt = await buildSystemPrompt({
    notebookTitle: 'Product map',
    cells: [],
    appId: state.pendo?.defaultAppId ?? -323232,
    agentSystemPrompt: agent.systemPrompt || undefined,
    agentInstructions: state.settings?.agentInstructions || undefined,
    customSkills: state.settings?.customSkills,
    ontologyDigest: noOntology ? undefined : (buildOntologyDigest(orgId, input.originNodeId) ?? undefined),
    defaultSegmentId: null,
    defaultSegmentName: null
  })

  const { builtIn: allBuiltIn, mcp, mcpConfigs } = await buildAllTools(orgId)
  const builtIn = noOntology ? allBuiltIn.filter(t => t.name !== 'lookup_ontology') : allBuiltIn
  const sessionId = `ontoask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  event.node.res.flushHeaders?.()

  // The related subgraph needs no agent — paint the graph highlight now.
  emit(event, { type: 'related', nodeIds: relatedNodeIds })

  // Each ask from the map is its own one-shot conversation — the panel keeps no
  // thread — so the generated session id doubles as the Pendo conversation id.
  const identity = resolveTurnIdentity(event, orgId)

  try {
    const result = await withAgentTurn(
      {
        orgId,
        conversationId: `ask:${sessionId}`,
        prompt: input.question,
        visitorId: identity.visitorId,
        accountId: identity.accountId,
        eventProperties: {
          surface: 'product-map-ask',
          ...(input.originNodeId ? { originNodeId: input.originNodeId } : {}),
          ...(noOntology ? { experiment: 'no-ontology' } : {})
        }
      },
      () => runAgentLoop({
        provider,
        model: agent.model,
        systemPrompt,
        messages: [{ role: 'user', content: input.question }],
        tools: [...builtIn, ...mcp],
        maxTokens: state.settings?.maxTokens ?? 4096,
        orgId,
        sessionId,
        mcpConfigs,
        defaultSegmentId: null,
        onTextDelta: (text) => emit(event, { type: 'text', text }),
        onToolStart: (tool, explanation) => emit(event, { type: 'tool_start', tool, explanation }),
        onToolEnd: (tool, success, rowCount, truncated) =>
          emit(event, { type: 'tool_result', success, rowCount, truncated }),
        onDone: (reason) => emit(event, { type: 'done', reason })
      }),
      (r) => r.textContent
    )

    emit(event, {
      type: 'result',
      result: {
        answer: result.textContent,
        aggregations: result.aggregationResults.map(r => ({
          dsl: r.dsl,
          rows: r.rows,
          columns: r.columns,
          explanation: r.explanation
        })),
        summaryCharts: result.summaryCharts,
        relatedNodeIds,
        runAt: new Date().toISOString()
      }
    })

    // Concept self-maintenance: enrich the existing concepts this exchange
    // touched (additive only; new concepts stay manual via Suggest). Runs
    // after `result` so it never delays the answer; the panel shows what was
    // learned when the event lands. Skipped entirely for noOntology control
    // runs so experiment traffic never mutates real concept data.
    if (!noOntology) {
      try {
        const updates = await evolveConcepts({
          orgId,
          provider,
          model: agent.model,
          question: input.question,
          answer: result.textContent,
          aggregations: result.aggregationResults,
          originNodeId: input.originNodeId
        })
        if (updates.length) emit(event, { type: 'concepts_evolved', updates })
      } catch (err: any) {
        console.error('[ask] concept evolution failed:', err.message)
      }
    }
  } catch (err: any) {
    abortSession(sessionId)
    emit(event, { type: 'error', message: err.message || 'Agent error' })
    emit(event, { type: 'done', reason: 'error' })
  }

  event.node.res.end()
})
