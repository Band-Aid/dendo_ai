import { z } from 'zod'
import { recordAgentReaction, resolveTurnIdentity } from '~/server/utils/pendoTracing'

const schema = z.object({
  /** Same conversation id the turn was reported under (see pendoTracing.ts). */
  conversationId: z.string().min(1),
  /** The agent_response id handed to `onResponseMessageId` for that turn. */
  messageId: z.string().min(1),
  reactionType: z.enum(['thumbs_up', 'thumbs_down', 'unreact', 'copy', 'retry', 'edit']),
  feedbackComment: z.string().max(4000).optional()
})

/**
 * Record a user reaction to an agent answer in Pendo Agent Analytics.
 *
 * Reactions are the one signal the SDK never infers — prompts, responses, and
 * traces are emitted automatically by `withAgentTurn`, but a thumbs-up has to be
 * sent explicitly when the user clicks it.
 *
 * NOTE: nothing calls this yet — Dendo has no feedback control in the chat UI.
 * The endpoint is here so adding one is a front-end-only change: send the
 * conversation id and the response message id back with the reaction.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'

  let input: z.infer<typeof schema>
  try {
    input = schema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  const identity = resolveTurnIdentity(event, orgId)
  const recorded = recordAgentReaction({
    conversationId: input.conversationId,
    messageId: input.messageId,
    reactionType: input.reactionType,
    feedbackComment: input.feedbackComment,
    visitorId: identity.visitorId,
    accountId: identity.accountId
  })

  // `recorded: false` means tracing is switched off or unconfigured — not a
  // client error, so don't fail the request the user's click triggered.
  return { recorded }
})
