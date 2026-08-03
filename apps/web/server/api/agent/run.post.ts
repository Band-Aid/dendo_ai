import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { getAgentSystemPrompt } from '~/server/utils/agentPrompts'
import { buildFeatureUsageDSL, buildSimpleUsageDSL } from '~/server/utils/pendoDslBuilder'

const requestSchema = z.object({
  question: z.string().min(1),
  mode: z.enum(['basic', 'analysis']).default('analysis'),
  goal: z.enum(['revenue', 'roi']).optional(),
  workspaceState: z.enum(['framing', 'learning', 'deciding']).optional().default('learning'),
  history: z.array(z.object({
    role: z.enum(['user', 'agent', 'assistant']),
    content: z.string()
  })).optional().default([])
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const input = requestSchema.parse(body)
  const orgId = event.context.orgId as string
  const state = await readAdminState(orgId)

  const orchestrator = state.agents.find((a) => a.enabled) || null
  
  if (!orchestrator) {
    return { error: 'No enabled agent configured. Please set up an agent in Admin.' }
  }
  
  const provider = state.providers.find((p) => p.provider === orchestrator.provider)
  if (!provider?.enabled) {
    return { error: `Provider ${orchestrator.provider} not configured or disabled.` }
  }

  // Basic mode: simple Q&A without aggregation
  if (input.mode === 'basic') {
    try {
      const configuredAppId = state.pendo?.defaultAppId ?? -323232
      const basicPrompt = buildNotebookBasicPrompt(input.question, configuredAppId)
      const rawAnswer = await callLLM(provider, orchestrator, basicPrompt, input.history, orgId)
      const parsed = parseNotebookBasicResponse(rawAnswer, input.question, configuredAppId)
      return {
        answer: parsed.answer,
        suggestedDsl: parsed.suggestedDsl
      }
    } catch (err: any) {
      return { error: err.message || 'Failed to get response from agent' }
    }
  }

  // Analysis mode: behavior depends on workspace state.
  // framing  -> understanding/clarification only (no evidence plan)
  // learning -> evidence gathering plan
  // deciding -> pressure-test summary from known evidence
  try {
    const analysisPrompt = buildAnalysisPrompt(
      input.question,
      input.goal || 'revenue',
      input.workspaceState || 'learning'
    )
    const rawAnswer = await callLLM(provider, orchestrator, analysisPrompt, input.history, orgId)
    const parsed = parseAnalysisResponse(
      rawAnswer,
      input.question,
      input.goal || 'revenue',
      input.workspaceState || 'learning'
    )

    return {
      forward_deployed_agent: parsed,
      routing: {
        orchestratorAgentId: orchestrator?.id || null,
        provider: orchestrator?.provider || null,
        model: orchestrator?.model || null
      }
    }
  } catch (err: any) {
    return { error: err.message || 'Agent analysis failed' }
  }
})

function buildAnalysisPrompt(
  question: string,
  goal: string,
  workspaceState: 'framing' | 'learning' | 'deciding'
): string {
  if (workspaceState === 'framing') {
    return `You are a forward-deployed decision agent in FRAMING mode.

The user is shaping a strategic decision question:
"${question}"

Primary lens: ${goal === 'roi' ? 'ROI (time saved, throughput, reduced errors)' : 'Revenue (upgrades, retention, expansion)'}

Your job in framing mode is to reduce ambiguity before any evidence gathering starts.

Respond with ONLY valid JSON in this format:
{
  "understanding": "Here’s my updated understanding...",
  "updated_question": "string or null",
  "updated_goal": "revenue|roi or null",
  "suggested_primary_metric": "string or null",
  "clarifying_questions": ["optional question 1", "optional question 2"],
  "ready_to_confirm": false
}

Critical framing rules:
- DO NOT generate hypotheses
- DO NOT generate data requests
- DO NOT write DSL
- DO NOT claim findings or evidence
- If details are unclear, ask 1-2 clarifying questions
- It is correct to say uncertainty remains until confirmation
- Keep tone concise and collaborative.`
  }

  if (workspaceState === 'deciding') {
    return `You are a forward-deployed decision agent in DECIDING mode.

The decision question is:
"${question}"

Primary lens: ${goal === 'roi' ? 'ROI (time saved, throughput, reduced errors)' : 'Revenue (upgrades, retention, expansion)'}

Respond with ONLY valid JSON in this format:
{
  "summary": "Short pressure-test style response focused on assumptions, confidence, and what evidence would change the decision.",
  "confidence": "low|med|high",
  "change_triggers": ["what would change the recommendation"],
  "next_questions": ["optional follow-up question"]
}

Rules:
- Do not invent data results.
- Be explicit about uncertainty.
- Keep it practical for decision-making.`
  }

  return `You are a forward-deployed decision agent in LEARNING mode. A user wants to investigate this strategic question:

"${question}"

Their primary lens is: ${goal === 'roi' ? 'ROI (time saved, throughput, reduced errors)' : 'Revenue (upgrades, retention, expansion)'}

You are planning evidence collection, not reporting evidence.

Think about:
1. What hypotheses could explain or answer this question?
2. What data would you need to test each hypothesis?
3. Write the actual Pendo DSL query for each data request using the grammar from the spec sheet

Respond with ONLY valid JSON in this exact format (no markdown, no code fences):
{
  "hypotheses": [
    {"id": "H1", "text": "description of hypothesis 1"},
    {"id": "H2", "text": "description of hypothesis 2"},
    {"id": "H3", "text": "description of hypothesis 3"}
  ],
  "data_requests": [
    {
      "id": "DR1",
      "metric": "metric_name",
      "population": "users",
      "dsl": "FROM event([source=events, appId=XYZ])\\nTIMESERIES period=dayRange first=now() count=-30\\n| group by visitorId fields { eventCount=sum(numEvents) }",
      "segments": ["segment1", "segment2"],
      "window": {"type": "relative", "days": 30},
      "breakdowns": ["breakdown_field"],
      "notes": "why this data matters"
    }
  ],
  "summary": "A 2-3 sentence summary in plain language for product managers. Explain what you'll investigate and why it matters. DO NOT use technical jargon, metric names, or structured data. Write like you're talking to a colleague."
}

IMPORTANT:
- Hypotheses and data requests are a plan, not evidence.
- Include the "dsl" field with a valid Pendo aggregation query for each data_request
- Use the appId from your Configuration section
- Follow the DSL grammar exactly as documented in the spec sheet
- Make sure DSL queries are appropriate for the question being asked
- For feature usage questions, use featureEvents source
- For retention/cohort questions, use appropriate time windows
- Escape newlines in the DSL string as \\n

Generate 2-4 hypotheses and 2-5 data requests. Be specific and actionable.`
}

function buildNotebookBasicPrompt(question: string, appId: number): string {
  return `You are the notebook side-chat assistant for a Pendo AggDSL product analytics app.

User question:
"${question}"

Return ONLY valid JSON with this shape:
{
  "answer": "short helpful response",
  "suggested_dsl": "AggDSL query string OR null"
}

Critical rules:
- ALWAYS use appId=${appId} in queries.
- If the question is unclear or missing critical information, set "suggested_dsl" to null and ask clarifying questions in "answer".
- Only provide a DSL query when you're confident it matches what the user wants.

AggDSL Examples:

1. Count unique visitors over past 30 days:
FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-30
| group by day fields {
    visitors=count(visitorId)
  }

2. Count total events per visitor (past 30 days):
FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-30
| group by visitorId fields {
    eventCount=sum(numEvents)
  }

3. Feature usage ranking (past 30 days):
FROM event([source=featureEvents, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-30
| group by featureId fields {
    visitors=count(visitorId),
    events=sum(numEvents)
  }

4. Daily active users (past 30 days):
FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-30
| group by day fields {
    activeUsers=count(visitorId)
  }

IMPORTANT: For "past N days from today", ALWAYS use count=-N (negative number)

Key principles:
- Choose the RIGHT aggregation for the question (don't always group by visitorId)
- For "count users/visitors" questions, group by day and use count(visitorId)
- For "events per user" questions, group by visitorId
- For feature questions, use featureEvents source and group by featureId
- Match the time window to what the user asks (7 days, 30 days, etc.)
- When in doubt, ASK for clarification rather than guessing

No markdown fences in the JSON, no extra keys.`
}

function parseNotebookBasicResponse(raw: string, question: string, appId: number): { answer: string; suggestedDsl: string | null } {
  let jsonStr = raw.trim()

  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    jsonStr = jsonStr.substring(braceStart, braceEnd + 1)
  }

  try {
    const parsed = JSON.parse(jsonStr)
    const answer = String(parsed.answer || '').trim() || 'I can help draft an AggDSL query for this.'
    const suggestedDsl = typeof parsed.suggested_dsl === 'string' ? parsed.suggested_dsl.trim() : null

    // Trust the agent's decision - if it returned null, it probably needs clarification
    return { answer, suggestedDsl }
  } catch (err) {
    console.error('[parseNotebookBasicResponse] JSON parse failed:', err)
    // Return the raw response as-is if we can't parse it
    const fallbackAnswer = raw.trim() || 'I can help draft an AggDSL query for this.'
    return {
      answer: fallbackAnswer,
      suggestedDsl: null
    }
  }
}

function parseAnalysisResponse(
  raw: string,
  question: string,
  goal: string,
  workspaceState: 'framing' | 'learning' | 'deciding'
): any {
  // Try to extract JSON from the response (handle markdown fences, leading text, etc.)
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

    if (workspaceState === 'framing') {
      return {
        goal,
        question,
        workspace_state: 'framing',
        understanding: parsed.understanding || 'Here’s my updated understanding.',
        updated_question: parsed.updated_question || null,
        updated_goal: parsed.updated_goal || null,
        suggested_primary_metric: parsed.suggested_primary_metric || null,
        clarifying_questions: parsed.clarifying_questions || [],
        ready_to_confirm: Boolean(parsed.ready_to_confirm),
        hypotheses: [],
        data_requests: [],
        summary: parsed.understanding || '',
        expected_artifacts: []
      }
    }

    if (workspaceState === 'deciding') {
      return {
        goal,
        question,
        workspace_state: 'deciding',
        hypotheses: [],
        data_requests: [],
        summary: parsed.summary || '',
        confidence: parsed.confidence || 'low',
        change_triggers: parsed.change_triggers || [],
        next_questions: parsed.next_questions || [],
        expected_artifacts: ['recommendations']
      }
    }

    return {
      goal,
      question,
      workspace_state: 'learning',
      hypotheses: parsed.hypotheses || [{ id: 'H1', text: parsed.summary || 'Analysis complete.' }],
      data_requests: parsed.data_requests || [],
      summary: parsed.summary || '',
      expected_artifacts: ['cards', 'charts']
    }
  } catch {
    if (workspaceState === 'framing') {
      return {
        goal,
        question,
        workspace_state: 'framing',
        understanding: raw.substring(0, 500),
        updated_question: null,
        updated_goal: null,
        suggested_primary_metric: null,
        clarifying_questions: [],
        ready_to_confirm: false,
        hypotheses: [],
        data_requests: [],
        summary: raw.substring(0, 500),
        expected_artifacts: []
      }
    }

    // If JSON parsing fails, treat the whole response as a text finding
    return {
      goal,
      question,
      workspace_state: workspaceState,
      hypotheses: [{ id: 'H1', text: raw.substring(0, 500) }],
      data_requests: [],
      summary: raw.substring(0, 500),
      expected_artifacts: workspaceState === 'deciding' ? ['recommendations'] : ['cards']
    }
  }
}

async function callLLM(provider: any, agent: any, question: string, history: Array<{role: string, content: string}> = [], orgId = 'default'): Promise<string> {
  // Include SKILL.md so agent knows how to write proper Pendo DSL
  // Pass question to load relevant examples conditionally
  const systemPrompt = await getAgentSystemPrompt(agent, true, question, orgId)
  
  // Build message history, converting 'agent' role to 'assistant' for API compatibility
  const messages: Array<{role: string, content: string}> = [
    { role: 'system', content: systemPrompt }
  ]
  
  // Add conversation history
  for (const msg of history) {
    messages.push({
      role: msg.role === 'agent' ? 'assistant' : msg.role,
      content: msg.content
    })
  }
  
  // Add current question
  messages.push({ role: 'user', content: question })
  
  if (provider.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: agent.model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      })
    })
    
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${error}`)
    }
    
    const data = await response.json()
    return data.choices[0]?.message?.content || 'No response from model'
  }
  
  if (provider.provider === 'anthropic') {
    // For Anthropic, we need to format messages without system in the array
    const anthropicMessages: Array<{role: string, content: string}> = []
    
    // Add conversation history (skip system messages)
    for (const msg of history) {
      anthropicMessages.push({
        role: msg.role === 'agent' ? 'assistant' : msg.role,
        content: msg.content
      })
    }
    
    // Add current question
    anthropicMessages.push({ role: 'user', content: question })
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 2000,
        system: [{ type: 'text', text: systemPrompt }],
        messages: anthropicMessages
      })
    })
    
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Anthropic API error: ${response.status} ${error}`)
    }
    
    const data = await response.json()
    return data.content[0]?.text || 'No response from model'
  }
  
  if (provider.provider === 'azure_openai') {
    if (!provider.endpoint) {
      throw new Error('Azure OpenAI endpoint not configured')
    }
    
    const apiVersion = provider.apiVersion || '2024-05-01-preview'
    const deployment = provider.deployment || agent.model
    
    // Normalize endpoint - strip any existing paths and just keep the base URL
    let baseEndpoint = provider.endpoint
      .replace(/\/+$/, '') // Remove trailing slashes
      .replace(/\/openai\/v1.*$/, '') // Remove OpenAI v1 style paths
      .replace(/\/openai\/deployments.*$/, '') // Remove any existing deployment paths
    
    // Construct proper Azure OpenAI URL
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    
    console.log('[Azure OpenAI] Base endpoint:', baseEndpoint)
    console.log('[Azure OpenAI] Full URL:', url)
    console.log('[Azure OpenAI] Deployment:', deployment)
    console.log('[Azure OpenAI] API Version:', apiVersion)
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': provider.apiKey
      },
      body: JSON.stringify({
        messages,
        max_completion_tokens: 8000
      })
    })
    
    if (!response.ok) {
      const error = await response.text()
      console.error('[Azure OpenAI] Error response:', response.status, error)
      throw new Error(`Azure OpenAI API error: ${response.status} ${error}`)
    }
    
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      // Return debugging info to help troubleshoot
      throw new Error(`No response from model. Response structure: ${JSON.stringify(data).substring(0, 500)}`)
    }
    return content
  }
  
  throw new Error(`Unsupported provider: ${provider.provider}`)
}
