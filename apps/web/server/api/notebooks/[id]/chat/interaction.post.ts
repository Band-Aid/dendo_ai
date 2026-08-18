import { z } from 'zod'
import { getNotebook } from '~/server/utils/notebookStore'
import { getOrCreateChatConversationId } from '~/server/utils/chatMessageStore'
import { loadPendoAgentConfig, recordAgentReaction, resolveTurnIdentity } from '~/server/utils/pendoTracing'
/**
 * What the user did with an agent answer. These mirror the action buttons on an
 * assistant message in the chat sidebar; each one is a signal that the answer
 * was good enough to keep, which is otherwise invisible in analytics.
 */
const ACTIONS = [
  /** "Add text to note" — the answer became a note cell. */
  'add_note',
  /** "Add DSL as query" — the generated DSL became a query cell. */
  'add_query',
  /** "Save as question" — the turn became a re-runnable question cell. */
  'save_question',
  /** An aggregation attached to the answer was added as a table/chart. */
  'add_aggregation',
  /** An agent-built summary chart was added to the notebook. */
  'add_chart'
] as const

const schema = z.object({
  /** The assistant message acted on — the id the UI already renders. */
  messageId: z.string().min(1),
  action: z.enum(ACTIONS),
  /** Optional free-form detail, e.g. the aggregation mode chosen. */
  detail: z.string().max(200).optional()
})

/**
 * Record a user interaction with an agent answer in Pendo Agent Analytics.
 *
 * The conversation id is resolved here rather than sent by the client: the
 * browser has no reason to know Dendo's analytics identifiers, and the notebook
 * already determines the thread (see `getOrCreateChatConversationId`).
 *
 * Pairing works because the agent stream reports its `agent_response` under the
 * chat message's own id, so `messageId` here is the same value the UI holds.
 *
 * Best-effort by design — a failed analytics write must never make the user's
 * click look like it failed, so this always returns 200 with a `recorded` flag.
 */
export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const notebookId = getRouterParam(event, 'id')!

  let input: z.infer<typeof schema>
  try {
    input = schema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  try {
    getNotebook(notebookId, orgId)
  } catch {
    throw createError({ statusCode: 404, message: 'Notebook not found' })
  }

  const identity = resolveTurnIdentity(event, orgId)
  const recorded = recordAgentReaction({
    conversationId: getOrCreateChatConversationId(notebookId),
    messageId: input.messageId,
    reactionType: input.action,
    feedbackComment: input.detail,
    visitorId: identity.visitorId,
    accountId: identity.accountId
  })

  return { recorded }
})
