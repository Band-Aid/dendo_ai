import { z } from 'zod'
import { getNotebook } from '~/server/utils/notebookStore'
import { readAdminState } from '~/server/utils/adminStore'
import { ensureLayer1Loaded, getLayer1Raw } from '~/server/utils/systemPrompt'
import { callLlm, type LlmResponse } from '~/server/utils/llmClient'

const schema = z.object({
  prompt: z.string().min(1).max(4000),
  existingDsl: z.string().optional().default('')
})

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

  try {
    getNotebook(notebookId, orgId)
  } catch {
    throw createError({ statusCode: 404, message: 'Notebook not found' })
  }

  const state = await readAdminState(orgId)
  const enabledAgents = state.agents.filter(a => a.enabled)
  if (!enabledAgents.length) {
    throw createError({ statusCode: 400, message: 'No agents configured.' })
  }
  const agent = enabledAgents[0]
  const provider = state.providers.find(p => p.provider === agent.provider && p.enabled)
  if (!provider?.apiKey) {
    throw createError({ statusCode: 400, message: `Provider "${agent.provider}" not configured.` })
  }

  await ensureLayer1Loaded()
  const layer1 = getLayer1Raw()
  const appId = state.pendo?.defaultAppId ?? -323232

  const systemPrompt = `${layer1}

---

You are generating aggDSL for an analyst. Default appId=${appId} unless the user names another app.

OUTPUT FORMAT — STRICT:
- Output ONLY the raw aggDSL source. No prose, no headers, no markdown code fences, no commentary.
- If a request is ambiguous, choose the most reasonable interpretation and emit DSL. Do not ask questions.
- If the user supplied an existing DSL block, treat it as the starting point and modify it; otherwise generate from scratch.`

  const existing = input.existingDsl.trim()
  const userContent = existing
    ? `Existing DSL:\n\`\`\`\n${existing}\n\`\`\`\n\nRequest: ${input.prompt}`
    : input.prompt

  let result: LlmResponse
  try {
    result = await callLlm({
      provider,
      model: agent.model,
      systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools: [],
      maxTokens: state.settings?.maxTokens ?? 2048,
      onTextDelta: () => {}
    })
  } catch (err: any) {
    // Surface the real upstream failure (e.g. an Azure/Anthropic gateway error)
    // instead of letting the raw throw bubble up — h3 would otherwise mask it
    // as a generic "internal server error" and the user has no idea why the
    // call failed. 502 = upstream provider error, not a bug in this handler.
    throw createError({ statusCode: 502, message: err?.message || 'LLM provider request failed' })
  }

  let dsl = result.textContent.trim()
  // Strip code fences if the model insists on them
  dsl = dsl.replace(/^```(?:aggdsl|dsl|text)?\n?/i, '').replace(/\n?```\s*$/i, '').trim()

  if (!dsl) {
    throw createError({ statusCode: 500, message: 'Model returned empty DSL' })
  }

  return { dsl }
})
