import { z } from 'zod'
import { getNotebook } from '~/server/utils/notebookStore'
import { readAdminState } from '~/server/utils/adminStore'
import { buildSystemPrompt, ensureLayer1Loaded } from '~/server/utils/systemPrompt'
import { buildOntologyDigest } from '~/server/utils/ontologyDigest'
import { buildAllTools } from '~/server/utils/toolRegistry'
import { runAgentLoop } from '~/server/utils/agentLoop'
import { withAgentTurn, resolveTurnIdentity } from '~/server/utils/pendoTracing'
import { abortSession } from '~/server/utils/aggregation'
import {
  compileDsl,
  runAggregation,
  enrichWithNames,
  extractRowsColumns
} from '~/server/utils/aggregation'
import { callLlm } from '~/server/utils/llmClient'
import type { ChatAggregation } from '~/server/utils/chatMessageStore'

const schema = z.object({
  question: z.string().min(1).max(8000),
  /** The exact DSLs captured on the first run. Re-run replays these verbatim —
   *  no query generation — so the data fetch is deterministic. */
  dsls: z.array(z.object({
    dsl: z.string().min(1),
    explanation: z.string().optional()
  })).min(1),
  /** Set when this question cell was created from a concept's cause/action/KPI
   *  on the Product map — forces that concept's full context into the digest. */
  originConceptId: z.string().optional()
})

/** Cap rows fed back to the LLM so a large result can't blow the context. */
const MAX_ROWS_FOR_LLM = 50

/**
 * Deterministic re-run of a saved question. Each stored DSL is replayed exactly
 * — same query, fresh data. If a query no longer compiles or runs (e.g. a
 * feature was renamed, an id changed), we don't give up on it: the agent
 * rethinks that DSL from the original question's intent and runs a corrected
 * one. The corrected DSL is returned so the cell heals itself — the next
 * re-run replays the fixed query deterministically. A single tool-less LLM
 * call then reinterprets the latest numbers against the original question.
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

  const { question, dsls, originConceptId } = input

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

  await ensureLayer1Loaded()
  const systemPrompt = await buildSystemPrompt({
    notebookTitle: notebook.title,
    cells: notebook.cells,
    appId: state.pendo?.defaultAppId ?? -323232,
    agentSystemPrompt: agent.systemPrompt || undefined,
    agentInstructions: state.settings?.agentInstructions || undefined,
    customSkills: state.settings?.customSkills,
    ontologyDigest: buildOntologyDigest(orgId, originConceptId) ?? undefined,
    defaultSegmentId: notebook.default_segment_id ?? null,
    defaultSegmentName: notebook.default_segment_name ?? null
  })

  // Tools are only built if we actually hit a failure that needs repair —
  // most re-runs replay cleanly and never need the agent.
  let toolsBundle: Awaited<ReturnType<typeof buildAllTools>> | null = null
  async function getTools() {
    if (!toolsBundle) toolsBundle = await buildAllTools(orgId)
    return toolsBundle
  }

  const maxTokens = state.settings?.maxTokens ?? 4096

  /**
   * Replay one stored DSL directly (no agent). Mirrors the query-cell run path.
   */
  async function replay(dsl: string): Promise<
    | { ok: true; rows: Record<string, unknown>[]; columns: string[] }
    | { ok: false; error: string }
  > {
    const compiled = await compileDsl(dsl, undefined, {
      defaultSegmentId: notebook.default_segment_id ?? null
    })
    if (!compiled.success) return { ok: false, error: `compile: ${compiled.error}` }
    const agg = await runAggregation(JSON.stringify(compiled.data), false, undefined, orgId)
    if (!agg.success) return { ok: false, error: `aggregate: ${agg.error}` }
    const enriched = await enrichWithNames(agg.data, undefined, orgId)
    const dataForExtraction = enriched.success ? enriched.data : agg.data
    const { rows, columns } = extractRowsColumns(dataForExtraction)
    return { ok: true, rows, columns }
  }

  /**
   * A stored query failed to replay — let the agent rethink the DSL from the
   * original question's intent and run a corrected one. Returns the repaired
   * aggregation (with its new DSL) or null if the agent couldn't recover.
   */
  async function repair(failingDsl: string, explanation: string | undefined, error: string) {
    const { builtIn, mcp, mcpConfigs } = await getTools()
    const sessionId = `qfix-${notebookId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const purpose = explanation?.trim() || '(no label was saved for this query)'
    const repairMessage =
      `While re-running a saved analysis, one of its queries failed and must be rebuilt.\n\n` +
      `The original question this analysis answers:\n${question}\n\n` +
      `What this specific query is meant to produce: ${purpose}\n\n` +
      `The saved DSL that is now failing:\n${failingDsl}\n\n` +
      `The error it produced:\n${error}\n\n` +
      `Rebuild a correct Pendo aggregation DSL that fulfils the same purpose for the original question, ` +
      `then run it with run_pendo_aggregation. Use the lookup tools if you need current feature, page, or ` +
      `segment ids. Run exactly one corrected aggregation — don't add extra queries.`
    try {
      const result = await runAgentLoop({
        provider,
        model: agent.model,
        systemPrompt,
        messages: [{ role: 'user', content: repairMessage }],
        tools: [...builtIn, ...mcp],
        maxTokens,
        orgId,
        sessionId,
        mcpConfigs,
        defaultSegmentId: notebook.default_segment_id ?? null,
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onDone: () => {}
      })
      // Take the last aggregation the agent successfully ran as the fix.
      const fixed = result.aggregationResults.at(-1)
      if (!fixed) return null
      return { dsl: fixed.dsl, rows: fixed.rows, columns: fixed.columns }
    } catch (err: any) {
      abortSession(sessionId)
      return null
    }
  }

  const runRerun = async () => {
    // 1. Replay each stored DSL; repair the ones that fail.
    const aggregations: ChatAggregation[] = []
    const unrecoverable: { explanation?: string; error: string }[] = []
    let repairedCount = 0
    for (const item of dsls) {
      const res = await replay(item.dsl)
      if (res.ok) {
        aggregations.push({ dsl: item.dsl, rows: res.rows, columns: res.columns, explanation: item.explanation })
        continue
      }
      // Failed — rethink the DSL.
      const fixed = await repair(item.dsl, item.explanation, res.error)
      if (fixed) {
        repairedCount++
        // Keep the original label so the UI/answer stays continuous, but adopt
        // the corrected DSL so the cell heals for next time.
        aggregations.push({ dsl: fixed.dsl, rows: fixed.rows, columns: fixed.columns, explanation: item.explanation })
      } else {
        unrecoverable.push({ explanation: item.explanation, error: res.error })
      }
    }

    if (aggregations.length === 0) {
      throw createError({
        statusCode: 502,
        message: `All ${dsls.length} saved quer${dsls.length === 1 ? 'y' : 'ies'} failed to re-run and could not be rebuilt: ${unrecoverable.map(f => f.error).join('; ')}`
      })
    }

    // 2. Hand the fresh data to the LLM and ask it to reinterpret — no tools, so
    //    it can't generate new queries. The data above is the single source.
    const dataBlocks = aggregations.map((a, i) => {
      const label = a.explanation?.trim() || `Result ${i + 1}`
      const shown = a.rows.slice(0, MAX_ROWS_FOR_LLM)
      const more = a.rows.length > MAX_ROWS_FOR_LLM
        ? `\n(+${a.rows.length - MAX_ROWS_FOR_LLM} more rows not shown)`
        : ''
      return `### ${label}\nColumns: ${a.columns.join(', ')}\nRows (${a.rows.length} total):\n${JSON.stringify(shown)}${more}`
    }).join('\n\n')

    const failureNote = unrecoverable.length
      ? `\n\nNote: ${unrecoverable.length} saved quer${unrecoverable.length === 1 ? 'y' : 'ies'} could not be re-run or rebuilt this time (${unrecoverable.map(f => f.explanation || 'unnamed').join(', ')}); answer from the data that did return and say so if it matters.`
      : ''

    const userMessage =
      `Original question:\n${question}\n\n` +
      `I re-ran the saved queries for this question. Here is the FRESH data:\n\n${dataBlocks}${failureNote}\n\n` +
      `Reinterpret this latest data and answer the original question. Be concise and specific with the current numbers. ` +
      `Do not ask to run anything else — the data above is already current and is all you have.`

    let answer = ''
    try {
      const res = await callLlm({
        provider,
        model: agent.model,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [],
        maxTokens,
        onTextDelta: () => {}
      })
      answer = res.textContent
    } catch (err: any) {
      throw createError({ statusCode: 500, message: err.message || 'Failed to reinterpret results' })
    }

    return {
      answer,
      aggregations,
      repairedCount,
      runAt: new Date().toISOString()
    }
  }

  // Reported to Pendo as one turn whose prompt is the *original* question, not
  // the internal reinterpretation/repair scaffolding — that's what the user
  // actually asked. The repair loop's own LLM and tool calls still show up as
  // trace spans underneath.
  const identity = resolveTurnIdentity(event, orgId)
  return withAgentTurn(
    {
      conversationId: `qrerun:${notebookId}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt: question,
      visitorId: identity.visitorId,
      accountId: identity.accountId,
      eventProperties: {
        surface: 'question-cell-rerun',
        notebookId,
        savedQueryCount: dsls.length,
        ...(originConceptId ? { originConceptId } : {})
      }
    },
    runRerun,
    (r) => r.answer
  )
})
