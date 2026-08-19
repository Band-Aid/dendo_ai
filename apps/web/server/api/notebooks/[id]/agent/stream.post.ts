import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getNotebook } from '~/server/utils/notebookStore'
import { readAdminState, resolveAgent } from '~/server/utils/adminStore'
import { buildSystemPrompt, ensureLayer1Loaded } from '~/server/utils/systemPrompt'
import { buildOntologyDigest } from '~/server/utils/ontologyDigest'
import { buildAllTools } from '~/server/utils/toolRegistry'
import { runAgentLoop } from '~/server/utils/agentLoop'
import { withAgentTurn, resolveTurnIdentity } from '~/server/utils/pendoTracing'
import { abortSession } from '~/server/utils/aggregation'
import { evolveConcepts } from '~/server/utils/conceptEvolution'
import {
  listChatMessages,
  insertChatMessage,
  getOrCreateChatConversationId,
  type ChatAggregation
} from '~/server/utils/chatMessageStore'
import type { ConversationMessage } from '~/server/utils/llmClient'

const schema = z.object({
  question: z.string().min(1).max(8000),
  referencedCellIds: z.array(z.string()).optional().default([]),
  sessionId: z.string().default('default'),
  /** Which configured agent to use; falls back to the first enabled one. */
  agentId: z.string().optional()
})

// In-process LLM message history (keyed by sessionId). The persisted chat
// messages in the DB are the source of truth for the UI; this map only carries
// tool_use / tool_result blocks across iterations within the same browser session.
const sessions = new Map<string, ConversationMessage[]>()

function emit(event: any, data: object) {
  event.node.res.write(`data: ${JSON.stringify(data)}\n\n`)
}

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

  const { question, referencedCellIds, sessionId, agentId } = input

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
  const agent = resolveAgent(enabledAgents, agentId)

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
    // Workspace-level free-form instructions written in Setup, injected into
    // the uncached Layer 3 of the system prompt.
    agentInstructions: state.settings?.agentInstructions || undefined,
    // User-defined skills from Setup. The system-prompt builder filters out
    // disabled ones and emits a trigger directory + bodies in Layer 3.
    customSkills: state.settings?.customSkills,
    ontologyDigest: buildOntologyDigest(orgId) ?? undefined,
    defaultSegmentId: notebook.default_segment_id ?? null,
    defaultSegmentName: notebook.default_segment_name ?? null,
    defaultAccountId: notebook.default_account_id ?? null
  })

  const { builtIn, mcp, mcpConfigs } = await buildAllTools(orgId)
  const allTools = [...builtIn, ...mcp]

  // Hydrate in-process LLM history from persisted chat on first hit of this session.
  if (!sessions.has(sessionId)) {
    const past = listChatMessages(notebookId)
    sessions.set(sessionId, past.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })))
  }
  const history = sessions.get(sessionId)!
  history.push({ role: 'user', content: question })

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  event.node.res.flushHeaders?.()

  // Persist + emit the user's message
  const userMessage = insertChatMessage({
    notebookId,
    role: 'user',
    content: question,
    referencedCellIds
  })
  emit(event, { type: 'message_created', message: userMessage })

  // The chat sidebar is the one genuinely multi-turn surface. The conversation
  // id is stored with the messages (see `chatMessageStore`) rather than derived
  // from the request's `sessionId`, which the client regenerates on every page
  // load — so the thread stays one conversation across reloads and only ends
  // when the user clears the chat.
  const identity = resolveTurnIdentity(event, orgId)
  const conversationId = getOrCreateChatConversationId(notebookId)
  // Minted up front so the answer carries one id everywhere: the chat row, the
  // message the UI renders, and Pendo's agent_response. `/chat/interaction`
  // relies on that to attribute a button click to this specific answer.
  const assistantMessageId = randomUUID()

  try {
    const result = await withAgentTurn(
      {
        orgId,
        conversationId,
        prompt: question,
        visitorId: identity.visitorId,
        accountId: identity.accountId,
        responseMessageId: assistantMessageId,
        eventProperties: {
          surface: 'notebook-chat',
          notebookId,
          ...(referencedCellIds.length ? { referencedCellCount: referencedCellIds.length } : {})
        }
      },
      () => runAgentLoop({
        provider,
        model: agent.model,
        systemPrompt,
        messages: [...history],
        tools: allTools,
        maxTokens: state.settings?.maxTokens ?? 4096,
        orgId,
        sessionId,
        mcpConfigs,
        defaultSegmentId: notebook.default_segment_id ?? null,
        defaultAccountId: notebook.default_account_id ?? null,
        onTextDelta: (text) => emit(event, { type: 'text', text }),
        onToolStart: (tool, explanation) => emit(event, { type: 'tool_start', tool, explanation }),
        onToolEnd: (tool, success, rowCount, truncated) =>
          emit(event, { type: 'tool_result', success, rowCount, truncated }),
        onDone: (reason) => emit(event, { type: 'done', reason })
      }),
      (r) => r.textContent
    )

    sessions.set(sessionId, result.messages)

    const aggregations: ChatAggregation[] = result.aggregationResults.map(r => ({
      dsl: r.dsl,
      rows: r.rows,
      columns: r.columns,
      explanation: r.explanation
    }))

    // For the "dsl saved with the prompt" requirement, store the first
    // aggregation's DSL on the assistant message itself when present. All
    // aggregations stay attached for "add to notebook" actions.
    const primaryDsl = aggregations.length > 0 ? aggregations[0].dsl : null

    const assistantMessage = insertChatMessage({
      id: assistantMessageId,
      notebookId,
      role: 'assistant',
      content: result.textContent,
      dsl: primaryDsl,
      aggregations,
      // `build_summary_chart` tool calls inside this turn become persisted
      // chart specs the chat sidebar can render and the user can add to the
      // notebook with one click.
      summaryCharts: result.summaryCharts
    })
    emit(event, { type: 'message_created', message: assistantMessage })

    // Concept self-maintenance, fire-and-forget: holding the stream open for
    // it would keep the chat input disabled for seconds after the answer.
    // Additive enrichment of existing concepts only — new concepts stay a
    // manual Suggest-drawer decision.
    evolveConcepts({
      orgId,
      provider,
      model: agent.model,
      question,
      answer: result.textContent,
      aggregations: result.aggregationResults
    }).catch((err: any) => console.error('[agent/stream] concept evolution failed:', err.message))
  } catch (err: any) {
    abortSession(sessionId)
    emit(event, { type: 'error', message: err.message || 'Agent error' })
    emit(event, { type: 'done', reason: 'error' })
  }

  event.node.res.end()
})
