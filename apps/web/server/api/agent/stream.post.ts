import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { getAgentSystemPrompt } from '~/server/utils/agentPrompts'
import { compileDsl, runAggregation, enrichWithNames } from '~/server/utils/aggregation'
import {
  getConversationSession,
  addMessage,
  getConversationHistory,
  markSkillDocLoaded,
  isSkillDocLoaded
} from '~/server/utils/conversationMemory'

const requestSchema = z.object({
  question: z.string().min(1),
  mode: z.enum(['basic', 'analysis']).default('basic'),
  sessionId: z.string().optional().default('default'),
  agentId: z.string().optional(),
  notebookMode: z.boolean().optional().default(false)
})

// Tool definitions for function calling — built dynamically with config appId
function buildTools(appId: number) {
  return [
  {
    type: 'function',
    function: {
      name: 'lookup_pendo_segments',
      description: 'Look up Pendo segment IDs by name. CRITICAL: You MUST use this tool to find segment IDs before using segments in aggregation queries. Pendo requires segment IDs, not names.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'The FULL segment name to search for, including all words and spaces (case-insensitive partial match). Examples: "JAPAN Paying customers", "Enterprise users", "Trial accounts". The search will match any segment containing this text.'
          }
        },
        required: ['search_term']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_pendo_features',
      description: 'Look up Pendo feature IDs by feature name. Use this when user mentions a feature by name and you need its featureId for aggregation queries.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Feature name or partial name to search. Example: "Segment dropdown".'
          }
        },
        required: ['search_term']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_pendo_aggregation',
      description: 'Execute a Pendo aggregation query to retrieve product usage data. Use this tool whenever you need to answer questions about user activity, feature usage, or any product metrics. This is your primary way to access real data.',
      parameters: {
        type: 'object',
        properties: {
          dsl: {
            type: 'string',
            description: `The Pendo aggregation DSL query. Must use correct syntax like: FROM event([source=events, appId=${appId}])\\nTIMESERIES period=dayRange first=now() count=-30\\n| group by visitorId fields { eventCount=sum(numEvents) }`
          },
          explanation: {
            type: 'string',
            description: 'Brief explanation of what this query does and what question it answers'
          }
        },
        required: ['dsl', 'explanation']
      }
    }
  }
  ]
}

// Anthropic tool format — built dynamically with config appId
function buildAnthropicTools(appId: number) {
  return [
  {
    name: 'lookup_pendo_segments',
    description: 'Look up Pendo segment IDs by name. CRITICAL: You MUST use this tool to find segment IDs before using segments in aggregation queries. Pendo requires segment IDs, not names.',
    input_schema: {
      type: 'object',
      properties: {
        search_term: {
          type: 'string',
          description: 'The FULL segment name to search for, including all words and spaces (case-insensitive partial match). Examples: "JAPAN Paying customers", "Enterprise users", "Trial accounts". The search will match any segment containing this text.'
        }
      },
      required: ['search_term']
    }
  },
  {
    name: 'lookup_pendo_features',
    description: 'Look up Pendo feature IDs by feature name. Use this when user mentions a feature by name and you need its featureId for aggregation queries.',
    input_schema: {
      type: 'object',
      properties: {
        search_term: {
          type: 'string',
          description: 'Feature name or partial name to search. Example: "Segment dropdown".'
        }
      },
      required: ['search_term']
    }
  },
  {
    name: 'run_pendo_aggregation',
    description: 'Execute a Pendo aggregation query to retrieve product usage data. Use this tool whenever you need to answer questions about user activity, feature usage, or any product metrics. This is your primary way to access real data.',
    input_schema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: `The Pendo aggregation DSL query. Must use correct syntax like: FROM event([source=events, appId=${appId}])\\nTIMESERIES period=dayRange first=now() count=-30\\n| group by visitorId fields { eventCount=sum(numEvents) }`
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of what this query does and what question it answers'
        }
      },
      required: ['dsl', 'explanation']
    }
  }
  ]
}

// Module-level tool arrays — rebuilt per request with the configured appId
let tools: ReturnType<typeof buildTools> = buildTools(-323232)
let anthropicTools: ReturnType<typeof buildAnthropicTools> = buildAnthropicTools(-323232)

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const input = requestSchema.parse(body)
  const orgId = event.context.orgId as string
  const state = await readAdminState(orgId)

  // Find agent: use specified agentId or default to first enabled agent
  const orchestrator = input.agentId 
    ? state.agents.find((a) => a.id === input.agentId && a.enabled)
    : state.agents.find((a) => a.enabled)
  
  if (!orchestrator) {
    return sendError(event, createError({ 
      statusCode: 400, 
      message: input.agentId 
        ? `Agent ${input.agentId} not found or not enabled` 
        : 'No enabled agent configured' 
    }))
  }
  
  const provider = state.providers.find((p) => p.provider === orchestrator.provider)
  if (!provider?.enabled) {
    return sendError(event, createError({ statusCode: 400, message: `Provider ${orchestrator.provider} not configured` }))
  }

  // Build tool definitions with the configured default appId
  const configuredAppId = state.pendo?.defaultAppId ?? -323232
  tools = buildTools(configuredAppId)
  anthropicTools = buildAnthropicTools(configuredAppId)
  
  // In notebook mode, remove execution tools - only keep lookup tools
  if (input.notebookMode) {
    tools = tools.filter(t => t.function.name !== 'run_pendo_aggregation')
    anthropicTools = anthropicTools.filter(t => t.name !== 'run_pendo_aggregation')
  }

  // Set headers for SSE
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  })

  // ALWAYS load SKILL.md - it's critical reference documentation
  // Previous "load once per session" optimization caused hallucination on follow-up questions
  // Pass the question to conditionally load relevant examples
  let systemPrompt = await getAgentSystemPrompt(orchestrator, true, input.question, orgId)
  
  // In notebook mode, add specific instructions
  if (input.notebookMode) {
    systemPrompt = `You are a Pendo AggDSL expert helping users write queries in a notebook environment.

⚠️ CRITICAL: You MUST use ONLY the exact AggDSL syntax from the documentation. DO NOT invent or modify syntax.

# Valid AggDSL Format (from SKILL.md)

The ONLY valid pattern is:
\`\`\`
FROM event([source=SOURCE, appId=APPID])
TIMESERIES period=dayRange first=now() count=-N
| group by FIELD fields {
    metric=aggregation(field)
  }
\`\`\`

Where:
- source: events, featureEvents, or other event sources
- appId: ALWAYS use ${configuredAppId}
- count: positive for future days, NEGATIVE for past days (e.g., -7 for past 7 days)
- FIELD: day, visitorId, featureId, etc.
- aggregation: count(), sum(), avg(), etc.

# Example Queries

**Count unique visitors over past 7 days:**
\`\`\`aggdsl
FROM event([source=events, appId=${configuredAppId}])
TIMESERIES period=dayRange first=now() count=-7
| group by day fields {
    visitors=count(visitorId)
  }
\`\`\`

**Events per visitor (past 30 days):**
\`\`\`aggdsl
FROM event([source=events, appId=${configuredAppId}])
TIMESERIES period=dayRange first=now() count=-30
| group by visitorId fields {
    eventCount=sum(numEvents)
  }
\`\`\`

**Feature usage ranking (past 30 days):**
\`\`\`aggdsl
FROM event([source=featureEvents, appId=${configuredAppId}])
TIMESERIES period=dayRange first=now() count=-30
| group by featureId fields {
    visitors=count(visitorId),
    events=sum(numEvents)
  }
\`\`\`

⚠️ CRITICAL: For "past N days from today", use count=-N (negative number)

# Tools Available
- **lookup_pendo_features**: Use this to find feature IDs when user mentions feature names
- **lookup_pendo_segments**: Use this to find segment IDs when user mentions segment names

# Your Job in Notebook Mode
1. When user asks for a query, USE THE EXACT PATTERNS ABOVE
2. Call lookup tools if needed to resolve feature/segment names to IDs
3. Return the DSL wrapped in \`\`\`aggdsl\`\`\` code blocks
4. Explain what the query does in plain language
5. DO NOT execute queries - just return the DSL
6. DO NOT invent new syntax - use ONLY the patterns shown above

` + systemPrompt
  }
  
  console.log('[stream.post] Question:', input.question)
  console.log('[stream.post] System prompt length:', systemPrompt.length, 'chars')
  console.log('[stream.post] System prompt preview:', systemPrompt.substring(0, 200))
  
  // Get session and update system message with fresh documentation
  const session = getConversationSession(input.sessionId)
  
  // Always ensure system message is first and up-to-date
  if (session.messages.length === 0 || session.messages[0].role !== 'system') {
    // No messages or first message isn't system - add system message
    session.messages.unshift({
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now()
    })
    console.log('[stream.post] Added NEW system message as first message')
  } else {
    // Update existing system message
    session.messages[0].content = systemPrompt
    session.messages[0].timestamp = Date.now()
    console.log('[stream.post] UPDATED existing system message')
  }
  
  // Add user message
  addMessage(input.sessionId, 'user', input.question)

  try {
    await streamLLM(event, provider, orchestrator, input.sessionId, state.settings?.maxTokens ?? 2000)
  } catch (err: any) {
    const errorMessage = `data: ${JSON.stringify({ error: err.message })}\n\n`
    event.node.res.write(errorMessage)
  }

  event.node.res.end()
})

async function streamLLM(event: any, provider: any, agent: any, sessionId: string, maxTokens: number = 2000) {
  // Get full conversation history (includes updated system message)
  const messages = getConversationHistory(sessionId)
  
  console.log('[streamLLM] Total messages:', messages.length)
  if (messages.length > 0 && messages[0].role === 'system') {
    const systemContent = messages[0].content?.toLowerCase() || ''
    console.log('[streamLLM] System message length:', messages[0].content?.length || 0, 'chars')
    console.log('[streamLLM] System message includes SKILL.md:', systemContent.includes('workflow reference') ? 'YES' : 'NO')
    console.log('[streamLLM] System message includes Spec Sheet:', systemContent.includes('complete dsl grammar') ? 'YES' : 'NO')
    console.log('[streamLLM] System message includes Session Replay:', systemContent.includes('session replay query examples') ? 'YES' : 'NO')
  }

  // Accumulate assistant response and tool calls
  let assistantResponse = ''
  let toolCalls: any[] = []
  let hadToolCalls = false
  const executionBudget = {
    aggregationCalls: 0,
    maxAggregationCalls: 8 // Safety limit - agent should signal "DONE" when finished
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
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: true
      })
    })
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`)
    }
    
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    
    if (!reader) throw new Error('No response body')
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(line => line.trim().startsWith('data: '))
      
      for (const line of lines) {
        const data = line.replace(/^data: /, '')
        if (data === '[DONE]') continue
        
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          
          if (delta?.content) {
            assistantResponse += delta.content
            event.node.res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`)
          }
          
          if (delta?.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index || 0
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: toolCall.id || '',
                  type: toolCall.type || 'function',
                  function: { name: toolCall.function?.name || '', arguments: '' }
                }
              }
              if (toolCall.function?.arguments) {
                toolCalls[index].function.arguments += toolCall.function.arguments
              }
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
    
    // Handle tool calls for OpenAI
    if (toolCalls.length > 0) {
      hadToolCalls = true
      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'lookup_pendo_segments') {
          try {
            const args = parseToolArguments(toolCall.function.arguments)
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up segments: "${args.search_term}"\n` })}

`)
            
            const segments = await lookupPendoSegments(args.search_term, orgId)
            const resultText = segments.length > 0
              ? segments.map(s => `${s.id}: ${s.name}`).join('\n')
              : 'No segments found'
            
            // Add assistant message with tool_calls
            addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
            
            // Add tool result
            addMessage(sessionId, 'tool', resultText, { tool_call_id: toolCall.id })
            
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${segments.length} segment(s)\n\n` })}

`)
            
            // Continue with tool result
            const followUpMessages = getConversationHistory(sessionId)
            
            const followUpResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`
              },
              body: JSON.stringify({
                model: agent.model,
                messages: followUpMessages,
                tools,
                tool_choice: 'auto',
                temperature: 0.7,
                max_tokens: maxTokens,
                stream: true
              })
            })
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    if (data === '[DONE]') continue
                    
                    try {
                      const parsed = JSON.parse(data)
                      const delta = parsed.choices?.[0]?.delta
                      
                      if (delta?.content) {
                        followUpContent += delta.content
                        event.node.res.write(`data: ${JSON.stringify({ content: delta.content })}

`)
                      }
                      
                      // Check for new tool calls in follow-up
                      if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                          const index = tc.index || 0
                          if (!followUpToolCalls[index]) {
                            followUpToolCalls[index] = {
                              id: tc.id || '',
                              type: tc.type || 'function',
                              function: { name: tc.function?.name || '', arguments: '' }
                            }
                          }
                          if (tc.function?.arguments) {
                            followUpToolCalls[index].function.arguments += tc.function.arguments
                          }
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent
            
            // Handle any new tool calls from the follow-up response
            let budgetExceeded = false
            for (const followUpToolCall of followUpToolCalls.filter(t => t)) {
              if (followUpToolCall.function.name === 'run_pendo_aggregation') {
                try {
                  const args = parseToolArguments(followUpToolCall.function.arguments)
                  if (!consumeAggregationBudget(executionBudget)) {
                    budgetExceeded = true
                    break
                  }
                  event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}

`)
                  
                  const result = await executePendoAggregation(args.dsl, sessionId, orgId)
                  
                  addMessage(sessionId, 'assistant', undefined, { tool_calls: [followUpToolCall] })
                  addMessage(sessionId, 'tool', JSON.stringify(result, null, 2), { tool_call_id: followUpToolCall.id })
                  
                  event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Got results. Analyzing...\n\n` })}

`)
                  
                  const finalMessages = getConversationHistory(sessionId)
                  const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${provider.apiKey}`
                    },
                    body: JSON.stringify({
                      model: agent.model,
                      messages: finalMessages,
                      temperature: 0.7,
                      max_tokens: maxTokens,
                      stream: true
                    })
                  })
                  
                  const finalReader = finalResponse.body?.getReader()
                  const finalDecoder = new TextDecoder()
                  let finalBuffer = ''
                  let finalContent = ''
                  
                  if (finalReader) {
                    while (true) {
                      const { done, value } = await finalReader.read()
                      if (done) break
                      
                      finalBuffer += finalDecoder.decode(value, { stream: true })
                      const lines = finalBuffer.split('\n')
                      finalBuffer = lines.pop() || ''
                      
                      for (const line of lines) {
                        if (line.startsWith('data: ')) {
                          const data = line.slice(6)
                          if (data === '[DONE]') continue
                          
                          try {
                            const parsed = JSON.parse(data)
                            const content = parsed.choices?.[0]?.delta?.content
                            if (content) {
                              finalContent += content
                              event.node.res.write(`data: ${JSON.stringify({ content })}

`)
                            }
                          } catch (e) {}
                        }
                      }
                    }
                  }
                  
                  if (finalContent) {
                    addMessage(sessionId, 'assistant', finalContent)
                  }
                  
                  assistantResponse += finalContent
                } catch (err: any) {
                  event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error running aggregation: ${err.message}\n` })}

`)
                }
              }
            }
            
            if (budgetExceeded) {
              event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
            }
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error looking up segments: ${err.message}\n` })}

`)
          }
        } else if (toolCall.function.name === 'run_pendo_aggregation') {
          try {
            const args = parseToolArguments(toolCall.function.arguments)
            if (!consumeAggregationBudget(executionBudget)) {
              hadToolCalls = true
              event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
              break
            }
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}

`)
            
            const result = await executePendoAggregation(args.dsl, sessionId, orgId)
            
            // Add assistant message with tool_calls to conversation history
            addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
            
            // Add tool result message to conversation history
            addMessage(sessionId, 'tool', JSON.stringify(result, null, 2), { tool_call_id: toolCall.id })
            
            // Continue conversation with tool result
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Got results. Analyzing...\n\n` })}

`)
            
            const followUpMessages = [
              ...getConversationHistory(sessionId)
            ]
            
            const followUpResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`
              },
              body: JSON.stringify({
                model: agent.model,
                messages: followUpMessages,
                tools,
                tool_choice: 'auto',
                temperature: 0.7,
                max_tokens: maxTokens,
                stream: true
              })
            })
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    if (data === '[DONE]') continue
                    
                    try {
                      const parsed = JSON.parse(data)
                      const delta = parsed.choices?.[0]?.delta
                      const content = delta?.content
                      if (content) {
                        followUpContent += content
                        event.node.res.write(`data: ${JSON.stringify({ content })}

`)
                      }

                      if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                          const index = tc.index || 0
                          if (!followUpToolCalls[index]) {
                            followUpToolCalls[index] = {
                              id: tc.id || '',
                              type: tc.type || 'function',
                              function: { name: tc.function?.name || '', arguments: '' }
                            }
                          }
                          if (tc.function?.arguments) {
                            followUpToolCalls[index].function.arguments += tc.function.arguments
                          }
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            // Store the analysis response
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent

            const chainedContent = await executeOpenAIStyleToolChain({
              event,
              sessionId,
              initialToolCalls: followUpToolCalls,
              bootstrapIfNoTools: true,
              executionBudget,
              requestFollowUp: (messages) => fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${provider.apiKey}`
                },
                body: JSON.stringify({
                  model: agent.model,
                  messages,
                  tools,
                  tool_choice: 'auto',
                  temperature: 0.7,
                  max_tokens: maxTokens,
                  stream: true
                })
              })
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error running aggregation: ${err.message}\n` })}

`)
            assistantResponse += await continueOpenAIAfterToolError({
              event,
              sessionId,
              toolCall,
              errorMessage: err.message,
              executionBudget,
              requestFollowUp: (messages) => fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${provider.apiKey}`
                },
                body: JSON.stringify({
                  model: agent.model,
                  messages,
                  tools,
                  tool_choice: 'auto',
                  temperature: 0.7,
                  max_tokens: maxTokens,
                  stream: true
                })
              })
            })
          }
        } else {
          try {
            const chainedContent = await executeOpenAIStyleToolChain({
              event,
              sessionId,
              initialToolCalls: [toolCall],
              executionBudget,
              requestFollowUp: (messages) => fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${provider.apiKey}`
                },
                body: JSON.stringify({
                  model: agent.model,
                  messages,
                  tools,
                  tool_choice: 'auto',
                  temperature: 0.7,
                  max_tokens: maxTokens,
                  stream: true
                })
              })
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error handling tool call: ${err.message}\n` })}

`)
          }
        }
      }
    }
  } else if (provider.provider === 'anthropic') {
    // Extract system message and conversation messages
    const systemMessage = messages.find(m => m.role === 'system')
    const conversationMessages = messages.filter(m => m.role !== 'system')
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: maxTokens,
        system: systemMessage?.content || '',
        messages: conversationMessages,
        tools: anthropicTools,
        stream: true
      })
    })
    
    if (!response.ok) {
      const errorBody = await response.text()
      console.error('[Anthropic API Error]', response.status, errorBody)
      throw new Error(`Anthropic API error: ${response.status} - ${errorBody}`)
    }
    
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    
    if (!reader) throw new Error('No response body')
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(line => line.trim().startsWith('data: '))
      
      for (const line of lines) {
        const data = line.replace(/^data: /, '')
        
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            assistantResponse += parsed.delta.text
            event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`)
          }
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            const toolUse = parsed.content_block
            toolCalls.push({ id: toolUse.id, name: toolUse.name, input: '' })
          }
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
            const lastTool = toolCalls[toolCalls.length - 1]
            if (lastTool) {
              lastTool.input += parsed.delta.partial_json
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
    
    // Handle tool calls for Anthropic
    if (toolCalls.length > 0) {
      hadToolCalls = true
      let budgetExceeded = false
      for (const toolCall of toolCalls) {
        if (toolCall.name === 'lookup_pendo_segments') {
          try {
            const args = parseToolArguments(toolCall.input)
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up segments: "${args.search_term}"\n` })}

`)
            
            const segments = await lookupPendoSegments(args.search_term, orgId)
            const resultText = segments.length > 0
              ? segments.map(s => `${s.id}: ${s.name}`).join('\n')
              : 'No segments found'
            
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${segments.length} segment(s)\n\n` })}

`)
            
            // Continue with tool result
            const followUpMessages = [
              ...conversationMessages,
              {
                role: 'assistant',
                content: [{
                  type: 'tool_use',
                  id: toolCall.id,
                  name: toolCall.name,
                  input: args
                }]
              },
              {
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content: resultText
                }]
              }
            ]
            
            const followUpResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': provider.apiKey,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                model: agent.model,
                max_tokens: maxTokens,
                system: systemMessage?.content || '',
                messages: followUpMessages,
                tools: anthropicTools,
                stream: true
              })
            })
            
            if (!followUpResponse.ok) {
              const errorBody = await followUpResponse.text()
              throw new Error(`Anthropic follow-up error: ${followUpResponse.status} - ${errorBody}`)
            }
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    try {
                      const parsed = JSON.parse(data)
                      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        followUpContent += parsed.delta.text
                        event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}

`)
                      } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
                        // New tool call starting
                        followUpToolCalls.push({
                          id: parsed.content_block.id,
                          name: parsed.content_block.name,
                          input: ''
                        })
                      } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
                        // Accumulate tool input
                        if (followUpToolCalls.length > 0) {
                          followUpToolCalls[followUpToolCalls.length - 1].input += parsed.delta.partial_json
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent
            
            // Continue executing tool calls until no more remain
            const chainedContent = await executeAnthropicToolChain({
              event,
              apiKey: provider.apiKey,
              model: agent.model,
              system: systemMessage?.content || '',
              sessionId,
              baseMessages: followUpMessages,
              pendingToolCalls: followUpToolCalls,
              bootstrapIfNoTools: true,
              executionBudget
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error looking up segments: ${err.message}\n` })}

`)
          }
        } else if (toolCall.name === 'run_pendo_aggregation') {
          try {
            const args = parseToolArguments(toolCall.input)
            if (!consumeAggregationBudget(executionBudget)) {
              budgetExceeded = true
              break
            }
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}

`)
            
            const result = await executePendoAggregation(args.dsl, sessionId, orgId)
            
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Got results. Analyzing...\n\n` })}

`)
            
            // Continue with tool result
            const followUpMessages = [
              ...conversationMessages,
              {
                role: 'assistant',
                content: [{
                  type: 'tool_use',
                  id: toolCall.id,
                  name: toolCall.name,
                  input: args
                }]
              },
              {
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content: JSON.stringify(result, null, 2)
                }]
              }
            ]
            
            const followUpResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': provider.apiKey,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                model: agent.model,
                max_tokens: maxTokens,
                system: systemMessage?.content || '',
                messages: followUpMessages,
                tools: anthropicTools,
                stream: true
              })
            })
            
            if (!followUpResponse.ok) {
              const errorBody = await followUpResponse.text()
              console.error('[Anthropic Follow-up API Error]', followUpResponse.status, errorBody)
              throw new Error(`Anthropic follow-up error: ${followUpResponse.status} - ${errorBody}`)
            }
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    try {
                      const parsed = JSON.parse(data)
                      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        followUpContent += parsed.delta.text
                        event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}

`)
                      } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
                        followUpToolCalls.push({
                          id: parsed.content_block.id,
                          name: parsed.content_block.name,
                          input: ''
                        })
                      } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
                        if (followUpToolCalls.length > 0) {
                          followUpToolCalls[followUpToolCalls.length - 1].input += parsed.delta.partial_json
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            // Store the analysis response
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent

            const chainedContent = await executeAnthropicToolChain({
              event,
              apiKey: provider.apiKey,
              model: agent.model,
              system: systemMessage?.content || '',
              sessionId,
              baseMessages: followUpMessages,
              pendingToolCalls: followUpToolCalls,
              bootstrapIfNoTools: true,
              executionBudget
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error running aggregation: ${err.message}\n` })}

`)
            assistantResponse += await continueAnthropicAfterToolError({
              event,
              apiKey: provider.apiKey,
              model: agent.model,
              system: systemMessage?.content || '',
              sessionId,
              baseMessages: conversationMessages,
              toolCall,
              errorMessage: err.message,
              executionBudget
            })
          }
        } else {
          try {
            const chainedContent = await executeAnthropicToolChain({
              event,
              apiKey: provider.apiKey,
              model: agent.model,
              system: systemMessage?.content || '',
              sessionId,
              baseMessages: conversationMessages,
              pendingToolCalls: [toolCall],
              executionBudget
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error handling tool call: ${err.message}\n` })}

`)
          }
        }
      }
      
      if (budgetExceeded) {
        event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
      }
    }
  } else if (provider.provider === 'azure_openai') {
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
        tools,
        tool_choice: 'auto',
        max_completion_tokens: 8000,
        stream: true
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Azure OpenAI] Error response:', response.status, errorText)
      throw new Error(`Azure OpenAI API error: ${response.status} - ${errorText}`)
    }
    
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    
    if (!reader) throw new Error('No response body')
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(line => line.trim().startsWith('data: '))
      
      for (const line of lines) {
        const data = line.replace(/^data: /, '')
        if (data === '[DONE]') continue
        
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          
          if (delta?.content) {
            assistantResponse += delta.content
            event.node.res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`)
          }
          
          if (delta?.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index || 0
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: toolCall.id || '',
                  type: toolCall.type || 'function',
                  function: { name: toolCall.function?.name || '', arguments: '' }
                }
              }
              if (toolCall.function?.arguments) {
                toolCalls[index].function.arguments += toolCall.function.arguments
              }
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
    
    // Handle tool calls for Azure OpenAI (same as OpenAI)
    if (toolCalls.length > 0) {
      hadToolCalls = true
      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'lookup_pendo_segments') {
          try {
            const args = parseToolArguments(toolCall.function.arguments)
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up segments: "${args.search_term}"\n` })}

`)
            
            const segments = await lookupPendoSegments(args.search_term, orgId)
            const resultText = segments.length > 0
              ? segments.map(s => `${s.id}: ${s.name}`).join('\n')
              : 'No segments found'
            
            // Add messages to conversation history
            addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
            addMessage(sessionId, 'tool', resultText, { tool_call_id: toolCall.id })
            
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${segments.length} segment(s)\n\n` })}

`)
            
            const followUpMessages = getConversationHistory(sessionId)
            
            const followUpResponse = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'api-key': provider.apiKey
              },
              body: JSON.stringify({
                messages: followUpMessages,
                tools,
                tool_choice: 'auto',
                max_completion_tokens: 8000,
                stream: true
              })
            })
            
            if (!followUpResponse.ok) {
              const errorText = await followUpResponse.text()
              throw new Error(`Azure OpenAI follow-up failed: ${followUpResponse.status} - ${errorText}`)
            }
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    if (data === '[DONE]') continue
                    
                    try {
                      const parsed = JSON.parse(data)
                      const content = parsed.choices?.[0]?.delta?.content
                      if (content) {
                        followUpContent += content
                        event.node.res.write(`data: ${JSON.stringify({ content })}

`)
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error looking up segments: ${err.message}\n` })}

`)
          }
        } else if (toolCall.function.name === 'run_pendo_aggregation') {
          try {
            const args = parseToolArguments(toolCall.function.arguments)
            if (!consumeAggregationBudget(executionBudget)) {
              hadToolCalls = true
              event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
              break
            }
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}

`)
            
            const result = await executePendoAggregation(args.dsl, sessionId, orgId)
            
            console.log('[Azure OpenAI Tool Call] Aggregation result:', JSON.stringify(result).substring(0, 500))
            
            // Add assistant message with tool_calls to conversation history
            addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
            
            // Add tool result message to conversation history
            addMessage(sessionId, 'tool', JSON.stringify(result, null, 2), { tool_call_id: toolCall.id })
            
            event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Got results. Analyzing...\n\n` })}

`)
            
            const followUpMessages = [
              ...getConversationHistory(sessionId)
            ]
            
            console.log('[Azure OpenAI Tool Call] Follow-up messages count:', followUpMessages.length)
            console.log('[Azure OpenAI Tool Call] Last 2 messages:', JSON.stringify(followUpMessages.slice(-2), null, 2))
            console.log('[Azure OpenAI Tool Call] Sending follow-up request to:', url)
            
            const followUpResponse = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'api-key': provider.apiKey
              },
              body: JSON.stringify({
                messages: followUpMessages,
                tools,
                tool_choice: 'auto',
                max_completion_tokens: 8000,
                stream: true
              })
            })
            
            if (!followUpResponse.ok) {
              const errorText = await followUpResponse.text()
              console.error('[Azure OpenAI Follow-up] Error:', followUpResponse.status, errorText)
              throw new Error(`Azure OpenAI follow-up failed: ${followUpResponse.status} - ${errorText}`)
            }
            
            const followUpReader = followUpResponse.body?.getReader()
            const followUpDecoder = new TextDecoder()
            let followUpBuffer = ''
            let followUpContent = ''
            let followUpToolCalls: any[] = []
            
            if (followUpReader) {
              while (true) {
                const { done, value } = await followUpReader.read()
                if (done) break
                
                followUpBuffer += followUpDecoder.decode(value, { stream: true })
                const lines = followUpBuffer.split('\n')
                followUpBuffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6)
                    if (data === '[DONE]') continue
                    
                    try {
                      const parsed = JSON.parse(data)
                      const delta = parsed.choices?.[0]?.delta
                      const content = delta?.content
                      if (content) {
                        followUpContent += content
                        event.node.res.write(`data: ${JSON.stringify({ content })}

`)
                      }

                      if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                          const index = tc.index || 0
                          if (!followUpToolCalls[index]) {
                            followUpToolCalls[index] = {
                              id: tc.id || '',
                              type: tc.type || 'function',
                              function: { name: tc.function?.name || '', arguments: '' }
                            }
                          }
                          if (tc.function?.arguments) {
                            followUpToolCalls[index].function.arguments += tc.function.arguments
                          }
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            
            console.log('[Azure OpenAI Follow-up] Content length:', followUpContent.length)
            
            // Store the analysis response
            if (followUpContent) {
              addMessage(sessionId, 'assistant', followUpContent)
            }
            
            assistantResponse += followUpContent

            const chainedContent = await executeOpenAIStyleToolChain({
              event,
              sessionId,
              initialToolCalls: followUpToolCalls,
              bootstrapIfNoTools: true,
              executionBudget,
              requestFollowUp: (messages) => fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': provider.apiKey
                },
                body: JSON.stringify({
                  messages,
                  tools,
                  tool_choice: 'auto',
                  max_completion_tokens: 8000,
                  stream: true
                })
              })
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error running aggregation: ${err.message}\n` })}

`)
            assistantResponse += await continueOpenAIAfterToolError({
              event,
              sessionId,
              toolCall,
              errorMessage: err.message,
              executionBudget,
              requestFollowUp: (messages) => fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': provider.apiKey
                },
                body: JSON.stringify({
                  messages,
                  tools,
                  tool_choice: 'auto',
                  max_completion_tokens: 8000,
                  stream: true
                })
              })
            })
          }
        } else {
          try {
            const chainedContent = await executeOpenAIStyleToolChain({
              event,
              sessionId,
              initialToolCalls: [toolCall],
              executionBudget,
              requestFollowUp: (messages) => fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': provider.apiKey
                },
                body: JSON.stringify({
                  messages,
                  tools,
                  tool_choice: 'auto',
                  max_completion_tokens: 8000,
                  stream: true
                })
              })
            })

            assistantResponse += chainedContent
          } catch (err: any) {
            event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ Error handling tool call: ${err.message}\n` })}

`)
          }
        }
      }
    }
  } else {
    throw new Error(`Unsupported provider: ${provider.provider}`)
  }
  
  // Store complete assistant response in conversation history (only if no tool calls)
  // Tool call responses are already stored in the tool call handler
  if (assistantResponse && !hadToolCalls) {
    addMessage(sessionId, 'assistant', assistantResponse)
  }
  
  event.node.res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
}

function parseToolArguments(raw: unknown) {
  if (typeof raw !== 'string') {
    return raw || {}
  }

  try {
    return JSON.parse(raw)
  } catch {
    // Repair invalid escapes like "\\|" in model-generated DSL JSON strings.
    const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    try {
      return JSON.parse(repaired)
    } catch (err: any) {
      throw new Error(`Invalid tool arguments JSON: ${err.message}`)
    }
  }
}

function rewriteDslFromPendoError(dsl: string, errorText: string) {
  const lowered = errorText.toLowerCase()
  const needsFeatureEventsAppIdFix =
    lowered.includes('source featureevents') &&
    lowered.includes('appid may not be specified') &&
    lowered.includes('featureid')

  if (!needsFeatureEventsAppIdFix) {
    return dsl
  }

  // Remove appId from featureEvents source blocks, preserving other params.
  // Example: source=featureEvents, appId=-123, featureId=abc -> source=featureEvents, featureId=abc
  return dsl.replace(
    /(source\s*=\s*featureEvents\s*,\s*)([^\]\n]*)/g,
    (_m, prefix, rest) => {
      const cleaned = String(rest)
        .split(',')
        .map(s => s.trim())
        .filter(s => s && !/^appId\s*=/.test(s))
        .join(', ')
      return `${prefix}${cleaned}`
    }
  )
}

function rewriteDslFromCompilerError(dsl: string, errorText: string) {
  const lowered = errorText.toLowerCase()

  // Common compiler error: missing `fields` keyword in group stage.
  if (lowered.includes('group syntax')) {
    // `| group by visitorId { ... }` -> `| group by visitorId fields { ... }`
    return dsl.replace(/(\|\s*group\s+by\s+[^\n{]+)\{/g, (_m, prefix) => {
      const trimmed = String(prefix).trimEnd()
      if (/\bfields\s*$/.test(trimmed)) {
        return `${trimmed} {`
      }
      return `${trimmed} fields {`
    })
  }

  return dsl
}

async function executePendoAggregation(dsl: string, sessionId: string | undefined, orgId = 'default') {
  console.log('[executePendoAggregation] Starting with DSL:', dsl.substring(0, 200))
  
  try {
    const resolvedFeatureDsl = await resolveFeatureIdsInDsl(dsl, orgId)
    const resolvedDsl = await resolvePageIdsInDsl(resolvedFeatureDsl, orgId)

    const state = await readAdminState(orgId)
    const pendoSettings = state.pendo
    
    if (!pendoSettings?.integrationKey || !pendoSettings?.apiEndpoint) {
      throw new Error('Pendo integration not configured. Please configure in Admin > Data Connections.')
    }
    
    // Compile DSL to JSON (with one rewrite/retry on known compiler errors)
    console.log('[executePendoAggregation] Compiling DSL...')
    let dslToRun = resolvedDsl
    let compiled = await compileDsl(dslToRun, sessionId)

    if (!compiled.success && !compiled.cancelled) {
      const rewrittenDsl = rewriteDslFromCompilerError(dslToRun, compiled.error || '')
      if (rewrittenDsl !== dslToRun) {
        console.log('[executePendoAggregation] Retrying compile with auto-rewritten DSL based on compiler error')
        dslToRun = rewrittenDsl
        compiled = await compileDsl(dslToRun, sessionId)
      }
    }

    if (!compiled.success) {
      if (compiled.cancelled) {
        throw new Error('Cancelled by user')
      }
      throw new Error(`DSL compilation failed: ${compiled.error}`)
    }
    
    console.log('[executePendoAggregation] Running aggregation...')
    // Run aggregation
    let result = await runAggregation(dslToRun, true, sessionId, orgId)

    if (!result.success && !result.cancelled) {
      const errorMsg = result.stderr || result.error || 'Unknown error'
      const rewritten = rewriteDslFromPendoError(dslToRun, errorMsg)
      if (rewritten !== dslToRun) {
        console.log('[executePendoAggregation] Retrying with auto-rewritten DSL based on server error')
        dslToRun = rewritten
        result = await runAggregation(dslToRun, true, sessionId, orgId)
      }
    }

    if (!result.success) {
      if (result.cancelled) {
        throw new Error('Cancelled by user')
      }
      const errorMsg = result.stderr || result.error || 'Unknown error'
      throw new Error(`Aggregation failed: ${errorMsg}`)
    }
    
    console.log('[executePendoAggregation] Success! Result keys:', Object.keys(result.data || {}))
    console.log('[executePendoAggregation] Result sample:', JSON.stringify(result.data).substring(0, 1000))
    
    // Enrich results with feature and page names
    console.log('[executePendoAggregation] Enriching with feature/page names...')
    const enriched = await enrichWithNames(result.data, sessionId, orgId)
    
    if (enriched.success) {
      console.log('[executePendoAggregation] Enrichment successful')
      return enriched.data
    } else {
      if (enriched.cancelled) {
        throw new Error('Cancelled by user')
      }
      console.warn('[executePendoAggregation] Enrichment failed, returning raw data:', enriched.error)
      return result.data
    }
  } catch (err: any) {
    console.error('[executePendoAggregation] Error:', err)
    throw err
  }
}

function shouldBootstrapContinuation(text?: string) {
  const value = String(text || '').toLowerCase().trim()
  if (!value) return false

  // Never bootstrap if agent explicitly signaled completion with "DONE"
  if (/\bDONE\b/i.test(text || '')) {
    return false
  }

  // Trigger only when the model sounds mid-plan and likely intended another tool call.
  const continuationCues = [
    'now let me',
    'next, let me',
    'next let me',
    'i will now',
    "i'll now",
    'let me now',
    'to understand this better, let me',
    'i found',
    'now i will'
  ]

  // Do not force more tool calls when it appears to have concluded.
  const completionCues = [
    'in summary',
    'to summarize',
    'overall',
    'key takeaways',
    'recommendation',
    'next steps',
    'conclusion'
  ]

  if (completionCues.some((cue) => value.includes(cue))) {
    return false
  }

  return continuationCues.some((cue) => value.includes(cue))
}

function consumeAggregationBudget(budget: { aggregationCalls: number; maxAggregationCalls: number }) {
  if (budget.aggregationCalls >= budget.maxAggregationCalls) {
    return false
  }

  budget.aggregationCalls += 1
  return true
}

async function executeOpenAIStyleToolChain(params: {
  event: any
  sessionId: string
  initialToolCalls: any[]
  requestFollowUp: (messages: any[]) => Promise<Response>
  bootstrapIfNoTools?: boolean
  executionBudget: { aggregationCalls: number; maxAggregationCalls: number }
}) {
  const { event, sessionId, requestFollowUp, bootstrapIfNoTools, executionBudget } = params
  let pendingToolCalls = params.initialToolCalls.filter(Boolean)
  let accumulatedContent = ''
  let iteration = 0
  const maxIterations = 6

  const readOpenAIStream = async (response: Response) => {
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const nextToolCalls: any[] = []

    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta

            if (delta?.content) {
              content += delta.content
              event.node.res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`)
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index || 0
                if (!nextToolCalls[index]) {
                  nextToolCalls[index] = {
                    id: tc.id || '',
                    type: tc.type || 'function',
                    function: { name: tc.function?.name || '', arguments: '' }
                  }
                }
                if (tc.function?.arguments) {
                  nextToolCalls[index].function.arguments += tc.function.arguments
                }
              }
            }
          } catch {
            // ignore malformed stream chunks
          }
        }
      }
    }

    return {
      content,
      toolCalls: nextToolCalls.filter(Boolean)
    }
  }

  // Some model responses stop at planning text (e.g. "Now let me...") without calling the next tool.
  // Bootstrap one extra follow-up turn with an explicit nudge when no tool calls are present.
  if (pendingToolCalls.length === 0 && bootstrapIfNoTools) {
    const history = getConversationHistory(sessionId)
    const lastAssistant = [...history].reverse().find((m: any) => m.role === 'assistant')
    const shouldBootstrap = shouldBootstrapContinuation(lastAssistant?.content)

    if (!shouldBootstrap) {
      return accumulatedContent
    }

    addMessage(
      sessionId,
      'user',
      'Continue now. If more data is needed, call the appropriate tool(s) immediately before further explanation.'
    )

    const bootstrapResponse = await requestFollowUp(getConversationHistory(sessionId))
    if (!bootstrapResponse.ok) {
      const errorText = await bootstrapResponse.text()
      throw new Error(`Bootstrap follow-up failed: ${bootstrapResponse.status} - ${errorText}`)
    }

    const bootstrap = await readOpenAIStream(bootstrapResponse)
    if (bootstrap.content) {
      addMessage(sessionId, 'assistant', bootstrap.content)
      accumulatedContent += bootstrap.content
    }

    // Check for completion signal from agent
    if (bootstrap.content && /\bDONE\b/.test(bootstrap.content)) {
      // Agent explicitly signaled completion - stop tool chain
      pendingToolCalls = []
    } else {
      pendingToolCalls = bootstrap.toolCalls
    }
  }

  while (pendingToolCalls.length > 0 && iteration < maxIterations) {
    iteration += 1
    let budgetExceeded = false

    for (const toolCall of pendingToolCalls) {
      try {
        if (toolCall?.function?.name === 'lookup_pendo_segments') {
          const args = parseToolArguments(toolCall.function.arguments || '{}')
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up segments: "${args.search_term}"\n` })}\n\n`)

          const segments = await lookupPendoSegments(args.search_term, orgId)
          const resultText = segments.length > 0
            ? segments.map((s: any) => `${s.id}: ${s.name}`).join('\n')
            : 'No segments found'

          addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
          addMessage(sessionId, 'tool', resultText, { tool_call_id: toolCall.id })

          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${segments.length} segment(s)\n\n` })}\n\n`)
        } else if (toolCall?.function?.name === 'lookup_pendo_features') {
          const args = parseToolArguments(toolCall.function.arguments || '{}')
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up features: "${args.search_term}"\n` })}\n\n`)

          const features = await lookupPendoFeatures(args.search_term, orgId)
          const resultText = features.length > 0
            ? features.slice(0, 20).map((f: any) => `${f.id}: ${f.name}`).join('\n')
            : 'No features found'

          addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
          addMessage(sessionId, 'tool', resultText, { tool_call_id: toolCall.id })

          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${features.length} feature(s)\n\n` })}\n\n`)
        } else if (toolCall?.function?.name === 'run_pendo_aggregation') {
          const args = parseToolArguments(toolCall.function.arguments || '{}')
          if (!consumeAggregationBudget(executionBudget)) {
            budgetExceeded = true
            break
          }
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}\n\n`)

          const result = await executePendoAggregation(args.dsl, sessionId, orgId)
          addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
          addMessage(sessionId, 'tool', JSON.stringify(result, null, 2), { tool_call_id: toolCall.id })

          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Got results. Analyzing...\n\n` })}\n\n`)
        }
      } catch (toolErr: any) {
        const errorText = `Tool execution error: ${toolErr.message}`
        addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
        addMessage(sessionId, 'tool', errorText, { tool_call_id: toolCall.id })
        event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ ${errorText}\n` })}\n\n`)
      }
    }

    // If budget was exceeded, stop the entire tool chain
    if (budgetExceeded) {
      event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
      break
    }

    const followUpResponse = await requestFollowUp(getConversationHistory(sessionId))
    if (!followUpResponse.ok) {
      const errorText = await followUpResponse.text()
      throw new Error(`Follow-up failed: ${followUpResponse.status} - ${errorText}`)
    }

    const followUp = await readOpenAIStream(followUpResponse)

    if (followUp.content) {
      addMessage(sessionId, 'assistant', followUp.content)
      accumulatedContent += followUp.content
    }

    // Check for completion signal from agent
    if (followUp.content && /\bDONE\b/.test(followUp.content)) {
      // Agent explicitly signaled completion - stop tool chain
      pendingToolCalls = []
    } else {
      pendingToolCalls = followUp.toolCalls
    }
  }

  if (pendingToolCalls.length > 0) {
    event.node.res.write(`data: ${JSON.stringify({ content: `\n\n⚠️ Reached tool-chain limit (${maxIterations}). Please narrow the query.\n` })}\n\n`)
  }

  return accumulatedContent
}

async function executeAnthropicToolChain(params: {
  event: any
  apiKey: string
  model: string
  system: string
  sessionId: string
  baseMessages: any[]
  pendingToolCalls: any[]
  bootstrapIfNoTools?: boolean
  executionBudget: { aggregationCalls: number; maxAggregationCalls: number }
}) {
  const { event, apiKey, model, system, sessionId, bootstrapIfNoTools, executionBudget } = params
  const workingMessages = [...params.baseMessages]
  let pendingToolCalls = [...params.pendingToolCalls]
  let accumulatedContent = ''
  let iteration = 0
  const maxIterations = 6

  if (pendingToolCalls.length === 0 && bootstrapIfNoTools) {
    const history = getConversationHistory(sessionId)
    const lastAssistant = [...history].reverse().find((m: any) => m.role === 'assistant')
    const shouldBootstrap = shouldBootstrapContinuation(lastAssistant?.content)

    if (!shouldBootstrap) {
      return accumulatedContent
    }

    const bootstrapMessages = [
      ...workingMessages,
      {
        role: 'user',
        content: 'Continue now. If more data is needed, call the appropriate tool(s) immediately before further explanation.'
      }
    ]

    const bootstrapResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: bootstrapMessages,
        tools: anthropicTools,
        stream: true
      })
    })

    if (!bootstrapResponse.ok) {
      const errorBody = await bootstrapResponse.text()
      throw new Error(`Anthropic bootstrap follow-up error: ${bootstrapResponse.status} - ${errorBody}`)
    }

    const bootstrapReader = bootstrapResponse.body?.getReader()
    const bootstrapDecoder = new TextDecoder()
    let bootstrapBuffer = ''
    let bootstrapContent = ''
    const bootstrapToolCalls: any[] = []

    if (bootstrapReader) {
      while (true) {
        const { done, value } = await bootstrapReader.read()
        if (done) break

        bootstrapBuffer += bootstrapDecoder.decode(value, { stream: true })
        const lines = bootstrapBuffer.split('\n')
        bootstrapBuffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              bootstrapContent += parsed.delta.text
              event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`)
            } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
              bootstrapToolCalls.push({
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                input: ''
              })
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
              if (bootstrapToolCalls.length > 0) {
                bootstrapToolCalls[bootstrapToolCalls.length - 1].input += parsed.delta.partial_json
              }
            }
          } catch {
            // ignore malformed stream chunk
          }
        }
      }
    }

    if (bootstrapContent) {
      addMessage(sessionId, 'assistant', bootstrapContent)
      accumulatedContent += bootstrapContent
    }

    // Check for completion signal from agent
    if (bootstrapContent && /\bDONE\b/.test(bootstrapContent)) {
      // Agent explicitly signaled completion - stop tool chain
      pendingToolCalls = []
    } else {
      pendingToolCalls = bootstrapToolCalls
    }
  }

  while (pendingToolCalls.length > 0 && iteration < maxIterations) {
    iteration += 1
    let budgetExceeded = false

    for (const toolCall of pendingToolCalls) {
      try {
        const args = parseToolArguments(toolCall.input)

        if (toolCall.name === 'lookup_pendo_segments') {
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up segments: "${args.search_term}"\n` })}\n\n`)
          const segments = await lookupPendoSegments(args.search_term, orgId)
          const resultText = segments.length > 0
            ? segments.map((s: any) => `${s.id}: ${s.name}`).join('\n')
            : 'No segments found'

          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${segments.length} segment(s)\n\n` })}\n\n`)

          workingMessages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: args }]
          })
          workingMessages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: resultText }]
          })
        } else if (toolCall.name === 'lookup_pendo_features') {
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Looking up features: "${args.search_term}"\n` })}\n\n`)
          const features = await lookupPendoFeatures(args.search_term, orgId)
          const resultText = features.length > 0
            ? features.slice(0, 20).map((f: any) => `${f.id}: ${f.name}`).join('\n')
            : 'No features found'

          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Found ${features.length} feature(s)\n\n` })}\n\n`)

          workingMessages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: args }]
          })
          workingMessages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: resultText }]
          })
        } else if (toolCall.name === 'run_pendo_aggregation') {
          if (!consumeAggregationBudget(executionBudget)) {
            budgetExceeded = true
            break
          }
          event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🔍 Running aggregation: ${args.explanation}\n`, dsl: args.dsl })}\n\n`)
          const result = await executePendoAggregation(args.dsl, sessionId, orgId)
          event.node.res.write(`data: ${JSON.stringify({ content: `\n✅ Query completed\n\n` })}\n\n`)

          workingMessages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: args }]
          })
          workingMessages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result, null, 2) }]
          })
        }
      } catch (toolErr: any) {
        const errorText = `Tool execution error: ${toolErr.message}`
        workingMessages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: parseToolArguments(toolCall.input) }]
        })
        workingMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: errorText }]
        })
        event.node.res.write(`data: ${JSON.stringify({ content: `\n\n❌ ${errorText}\n` })}\n\n`)
      }
    }

    // If budget was exceeded, stop the entire tool chain
    if (budgetExceeded) {
      event.node.res.write(`data: ${JSON.stringify({ content: `\n\n🛑 Stopped after ${executionBudget.maxAggregationCalls} aggregations. Ask a follow-up if you need more analysis.\n` })}\n\n`)
      break
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: workingMessages,
        tools: anthropicTools,
        stream: true
      })
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Anthropic chained call error: ${response.status} - ${errorBody}`)
    }

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let roundContent = ''
    const nextToolCalls: any[] = []

    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              roundContent += parsed.delta.text
              event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`)
            } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
              nextToolCalls.push({
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                input: ''
              })
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
              if (nextToolCalls.length > 0) {
                nextToolCalls[nextToolCalls.length - 1].input += parsed.delta.partial_json
              }
            }
          } catch {
            // ignore malformed stream chunk
          }
        }
      }
    }

    if (roundContent) {
      addMessage(sessionId, 'assistant', roundContent)
      accumulatedContent += roundContent
    }

    // Check for completion signal from agent
    if (roundContent && /\bDONE\b/.test(roundContent)) {
      // Agent explicitly signaled completion - stop tool chain
      pendingToolCalls = []
    } else {
      pendingToolCalls = nextToolCalls
    }
  }

  if (pendingToolCalls.length > 0) {
    event.node.res.write(`data: ${JSON.stringify({ content: `\n\n⚠️ Reached tool-chain limit (${maxIterations}). Please refine the request.\n` })}\n\n`)
  }

  return accumulatedContent
}

async function continueOpenAIAfterToolError(params: {
  event: any
  sessionId: string
  toolCall: any
  errorMessage: string
  requestFollowUp: (messages: any[]) => Promise<Response>
  executionBudget: { aggregationCalls: number; maxAggregationCalls: number }
}) {
  const { event, sessionId, toolCall, errorMessage, requestFollowUp, executionBudget } = params
  const toolErrorText = `Tool execution error: ${errorMessage}`

  addMessage(sessionId, 'assistant', undefined, { tool_calls: [toolCall] })
  addMessage(sessionId, 'tool', toolErrorText, { tool_call_id: toolCall.id })

  const response = await requestFollowUp(getConversationHistory(sessionId))
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Error-recovery follow-up failed: ${response.status} - ${body}`)
  }

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const followUpToolCalls: any[] = []

  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) {
            content += delta.content
            event.node.res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`)
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index || 0
              if (!followUpToolCalls[index]) {
                followUpToolCalls[index] = {
                  id: tc.id || '',
                  type: tc.type || 'function',
                  function: { name: tc.function?.name || '', arguments: '' }
                }
              }
              if (tc.function?.arguments) {
                followUpToolCalls[index].function.arguments += tc.function.arguments
              }
            }
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }

  let accumulated = ''
  if (content) {
    addMessage(sessionId, 'assistant', content)
    accumulated += content
  }

  if (followUpToolCalls.filter(Boolean).length > 0) {
    accumulated += await executeOpenAIStyleToolChain({
      event,
      sessionId,
      initialToolCalls: followUpToolCalls,
      executionBudget,
      requestFollowUp
    })
  }

  return accumulated
}

async function continueAnthropicAfterToolError(params: {
  event: any
  apiKey: string
  model: string
  system: string
  sessionId: string
  baseMessages: any[]
  toolCall: any
  errorMessage: string
  executionBudget: { aggregationCalls: number; maxAggregationCalls: number }
}) {
  const { event, apiKey, model, system, sessionId, baseMessages, toolCall, errorMessage, executionBudget } = params
  const args = parseToolArguments(toolCall.input)
  const toolErrorText = `Tool execution error: ${errorMessage}`

  const followUpMessages = [
    ...baseMessages,
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: args }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: toolErrorText }]
    }
  ]

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: followUpMessages,
      tools: anthropicTools,
      stream: true
    })
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Error-recovery follow-up failed: ${response.status} - ${body}`)
  }

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: any[] = []

  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            content += parsed.delta.text
            event.node.res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`)
          } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            toolCalls.push({ id: parsed.content_block.id, name: parsed.content_block.name, input: '' })
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
            if (toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].input += parsed.delta.partial_json
            }
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }

  let accumulated = ''
  if (content) {
    addMessage(sessionId, 'assistant', content)
    accumulated += content
  }

  if (toolCalls.length > 0) {
    accumulated += await executeAnthropicToolChain({
      event,
      apiKey,
      model,
      system,
      sessionId,
      baseMessages: followUpMessages,
      pendingToolCalls: toolCalls,
      executionBudget
    })
  }

  return accumulated
}

async function resolveFeatureIdsInDsl(dsl: string, orgId = 'default') {
  // Match patterns like featureId="..." or featureId='...'
  const featureRefRegex = /featureId\s*=\s*(["'])([^"']+)\1/g
  const matches = [...dsl.matchAll(featureRefRegex)]

  if (matches.length === 0) {
    return dsl
  }

  let resolvedDsl = dsl
  const seen = new Set<string>()

  for (const match of matches) {
    const rawValue = match[2]?.trim()
    if (!rawValue || seen.has(rawValue)) {
      continue
    }
    seen.add(rawValue)

    // Heuristic: feature names usually contain spaces. IDs usually don't.
    // If this is already likely an ID, skip lookup.
    if (!rawValue.includes(' ')) {
      continue
    }

    const features = await lookupPendoFeatures(rawValue, orgId)
    const exact = features.find((f: any) => f.name?.toLowerCase() === rawValue.toLowerCase())
    const chosen = exact || features[0]

    if (chosen?.id) {
      const escapedRaw = rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const replaceRegex = new RegExp(`(featureId\\s*=\\s*["'])${escapedRaw}(["'])`, 'g')
      resolvedDsl = resolvedDsl.replace(replaceRegex, `$1${chosen.id}$2`)
      console.log(`[resolveFeatureIdsInDsl] Resolved feature name "${rawValue}" -> "${chosen.id}"`)
    }
  }

  return resolvedDsl
}

async function resolvePageIdsInDsl(dsl: string, orgId = 'default') {
  // Match patterns like pageId="..." or pageId='...'
  const pageRefRegex = /pageId\s*=\s*(["'])([^"']+)\1/g
  const matches = [...dsl.matchAll(pageRefRegex)]

  if (matches.length === 0) {
    return dsl
  }

  let resolvedDsl = dsl
  const seen = new Set<string>()

  for (const match of matches) {
    const rawValue = match[2]?.trim()
    if (!rawValue || seen.has(rawValue)) {
      continue
    }
    seen.add(rawValue)

    const pages = await lookupPendoPages(rawValue, orgId)
    const exact = pages.find((p: any) => p.name?.toLowerCase() === rawValue.toLowerCase())
    const chosen = exact || pages[0]

    if (chosen?.id) {
      const escapedRaw = rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const replaceRegex = new RegExp(`(pageId\\s*=\\s*["'])${escapedRaw}(["'])`, 'g')
      resolvedDsl = resolvedDsl.replace(replaceRegex, `$1${chosen.id}$2`)
      console.log(`[resolvePageIdsInDsl] Resolved page name "${rawValue}" -> "${chosen.id}"`)
    }
  }

  return resolvedDsl
}

async function lookupPendoSegments(searchTerm: string, orgId = 'default') {
  console.log('[lookupPendoSegments] Searching for:', searchTerm)
  
  try {
    const state = await readAdminState(orgId)
    const pendoSettings = state.pendo
    
    if (!pendoSettings?.integrationKey) {
      throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')
    }

    const { execa } = await import('execa')
    const projectRoot = process.cwd().replace('/apps/web', '')
    
    const result = await execa('python', ['-m', 'tools.pendo.lookup_segments', searchTerm], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PENDO_API_KEY: pendoSettings.integrationKey,
        PENDO_INTEGRATION_KEY: pendoSettings.integrationKey
      }
    })
    
    if (result.exitCode !== 0) {
      throw new Error(`Segment lookup failed: ${result.stderr}`)
    }
    
    // Parse output: each line is "ID\tName"
    const lines = result.stdout.trim().split('\n').filter(l => l && !l.startsWith('  →'))
    const segments = lines.map(line => {
      const [id, ...nameParts] = line.split('\t')
      return { id, name: nameParts.join('\t') }
    })
    
    console.log('[lookupPendoSegments] Found', segments.length, 'segments')
    return segments
  } catch (err: any) {
    console.error('[lookupPendoSegments] Error:', err)
    throw new Error(`Failed to lookup segments: ${err.message}`)
  }
}

async function lookupPendoFeatures(searchTerm: string, orgId = 'default') {
  const state = await readAdminState(orgId)
  const pendoSettings = state.pendo

  if (!pendoSettings?.integrationKey) {
    throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')
  }

  const response = await fetch('https://app.pendo.io/api/v1/feature', {
    method: 'GET',
    headers: {
      'x-pendo-integration-key': pendoSettings.integrationKey
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Feature lookup failed: ${response.status} - ${errorText}`)
  }

  const features = await response.json()
  const query = searchTerm.toLowerCase()
  return (Array.isArray(features) ? features : []).filter((f: any) => {
    const name = String(f?.name || '')
    return name.toLowerCase().includes(query)
  })
}

async function lookupPendoPages(searchTerm: string, orgId = 'default') {
  const state = await readAdminState(orgId)
  const pendoSettings = state.pendo

  if (!pendoSettings?.integrationKey) {
    throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')
  }

  const response = await fetch('https://app.pendo.io/api/v1/page', {
    method: 'GET',
    headers: {
      'x-pendo-integration-key': pendoSettings.integrationKey
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Page lookup failed: ${response.status} - ${errorText}`)
  }

  const pages = await response.json()
  const query = searchTerm.toLowerCase()
  return (Array.isArray(pages) ? pages : []).filter((p: any) => {
    const name = String(p?.name || '')
    return name.toLowerCase().includes(query)
  })
}