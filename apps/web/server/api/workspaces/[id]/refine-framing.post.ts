import { readAdminState } from '~/server/utils/adminStore'
import { getWorkspaceById, updateFramingRefinement } from '~/server/utils/workspaceStore'

interface RefineFramingRequest {
  message: string
}

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  const body = await readBody<RefineFramingRequest>(event)
  
  if (!workspaceId || !body.message?.trim()) {
    throw createError({
      statusCode: 400,
      message: 'Workspace ID and message are required'
    })
  }

  const orgId = event.context.orgId as string
  const workspace = getWorkspaceById(workspaceId, orgId)

  if (!workspace) {
    throw createError({
      statusCode: 404,
      message: 'Workspace not found'
    })
  }

  if (workspace.workspaceState !== 'framing') {
    throw createError({
      statusCode: 400,
      message: 'Workspace is not in framing state'
    })
  }

  try {
    // Get agent and provider settings
    const state = await readAdminState(orgId)
    const agent = state.agents.find((a) => a.enabled)
    const provider = agent ? state.providers.find((p) => p.provider === agent.provider) : null

    if (!agent || !provider?.enabled) {
      throw createError({
        statusCode: 400,
        message: 'No enabled agent configured'
      })
    }

    // Add user's refinement message to framing notes
    const userNote = {
      role: 'user' as const,
      content: body.message.trim(),
      timestamp: new Date().toISOString()
    }

    const framingNotes = [...workspace.framingNotes, userNote]

    // Call agent to get understanding update (framing mode)
    const agentPrompt = buildFramingRefinementPrompt(workspace, body.message.trim())
    const agentResponse = await callAgentForFraming(provider, agent, agentPrompt)

    // Parse agent response
    const understanding = parseFramingResponse(agentResponse)

    // Add agent's understanding update to framing notes
    const agentNote = {
      role: 'agent' as const,
      content: understanding.understanding,
      timestamp: new Date().toISOString()
    }
    framingNotes.push(agentNote)

    // Update workspace with new understanding and notes
    const updates: any = {
      framingNotes
    }

    if (understanding.updatedTitle) {
      updates.title = understanding.updatedTitle
    }

    if (understanding.updatedQuestion) {
      updates.decisionQuestion = understanding.updatedQuestion
    }

    if (understanding.updatedLens) {
      updates.goalType = understanding.updatedLens
    }

    if (understanding.suggestedMetric) {
      updates.primarySuccessMetric = understanding.suggestedMetric
    }

    const updatedWorkspace = updateFramingRefinement(workspaceId, updates, orgId)

    return {
      workspace: updatedWorkspace,
      understanding: understanding.understanding,
      clarifyingQuestions: understanding.clarifyingQuestions || []
    }
  } catch (error: any) {
    console.error('[refine-framing] Error:', error)
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to process framing refinement'
    })
  }
})

function buildFramingRefinementPrompt(workspace: any, userMessage: string): string {
  const context = workspace.context || {}
  const goalType = context.goalType || 'revenue'
  const lens = goalType === 'roi' ? 'ROI (time saved, throughput, reduced errors)' : 'Revenue (upgrades, retention, expansion)'

  return `You are helping refine the framing of a strategic decision in FRAMING MODE.

# Current Understanding

**Decision Question:** ${workspace.decisionQuestion}
**Decision Title:** ${context.decisionTitle || 'Not set'}
**Lens:** ${lens}
**Primary Metric:** ${context.primarySuccessMetric || 'Not set'}

# User's Refinement

The user said: "${userMessage}"

# Your Task

Respond with ONLY valid JSON in this exact format (no markdown, no code fences):
{
  "understanding": "Brief restatement showing you understand the refinement (2-3 sentences max)",
  "updatedTitle": "new title if changed, otherwise null",
  "updatedQuestion": "new question if changed, otherwise null",
  "updatedLens": "revenue or roi if changed, otherwise null",
  "suggestedMetric": "suggested primary metric if relevant, otherwise null",
  "clarifyingQuestions": ["optional question 1", "optional question 2"]
}

# Critical Rules for FRAMING MODE

- DO NOT mention data, results, evidence, or findings
- DO NOT create recommendations or insights
- DO NOT reference any product features or usage patterns
- DO say "I'll investigate that once you confirm the framing"
- DO ask clarifying questions if the user's input creates ambiguity
- Keep the understanding message SHORT and conversational

Example good understanding:
"Got it — you want to focus only on the first 7 days after signup, excluding enterprise customers. I'll limit my analysis to that window once you're ready to start gathering evidence."

Example bad understanding:
"Based on the data, I found that 65% of users who upgraded..."

Respond ONLY with the JSON object.`
}

async function callAgentForFraming(provider: any, agent: any, prompt: string): Promise<string> {
  if (provider.provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    return data.content[0].text
  }

  if (provider.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: agent.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1000
      })
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`)
    }

    const data = await response.json()
    return data.choices[0].message.content
  }

  throw new Error('Unsupported provider')
}

function parseFramingResponse(raw: string): {
  understanding: string
  updatedTitle?: string | null
  updatedQuestion?: string | null
  updatedLens?: 'revenue' | 'roi' | null
  suggestedMetric?: string | null
  clarifyingQuestions?: string[]
} {
  // Try to extract JSON from the response
  let jsonStr = raw.trim()

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  // Try to find a JSON object in the text
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    jsonStr = jsonStr.substring(braceStart, braceEnd + 1)
  }

  try {
    const parsed = JSON.parse(jsonStr)
    return {
      understanding: parsed.understanding || 'Understanding updated.',
      updatedTitle: parsed.updatedTitle || null,
      updatedQuestion: parsed.updatedQuestion || null,
      updatedLens: parsed.updatedLens || null,
      suggestedMetric: parsed.suggestedMetric || null,
      clarifyingQuestions: parsed.clarifyingQuestions || []
    }
  } catch {
    // Fall back to treating response as understanding text
    return {
      understanding: raw.substring(0, 300)
    }
  }
}
