import type { ProviderConfig } from '~/server/utils/adminStore'
import { traceGeneration } from '~/server/utils/pendoTracing'

export interface UnifiedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * Token accounting for one call, when the provider reports it. Anthropic sends
 * this inline on the SSE stream; OpenAI only does when the deployment opts into
 * usage on streamed responses, so treat every field as best-effort.
 */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

export interface LlmResponse {
  textContent: string
  toolCalls: ToolCall[]
  stopReason: string
  usage?: LlmUsage
}

export interface LlmCallOptions {
  provider: ProviderConfig
  model: string
  systemPrompt: string
  messages: ConversationMessage[]
  tools: UnifiedTool[]
  maxTokens: number
  onTextDelta: (text: string) => void
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string | ContentBlock[]
  tool_call_id?: string
}

interface ContentBlock {
  type: string
  [key: string]: unknown
}

function toAnthropicTools(tools: UnifiedTool[]) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

function toOpenAiTools(tools: UnifiedTool[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

function anthropicMessagesToApi(messages: ConversationMessage[]): any[] {
  const result: any[] = []
  for (const m of messages) {
    if (m.role === 'tool_result') {
      // tool_result is stored as an array containing one user message with tool_result blocks
      if (Array.isArray(m.content)) {
        for (const block of m.content as any[]) {
          result.push(block)
        }
      }
    } else {
      result.push({ role: m.role, content: m.content })
    }
  }
  return result
}

function openAiMessagesToApi(messages: ConversationMessage[]): any[] {
  const result: any[] = []
  for (const m of messages) {
    if (m.role === 'tool_result') {
      // tool_result stored as array of {role:'tool', content, tool_call_id}
      if (Array.isArray(m.content)) {
        for (const block of m.content as any[]) {
          result.push(block)
        }
      }
    } else {
      result.push({ role: m.role, content: m.content })
    }
  }
  return result
}

/**
 * The model that actually serves the request. For Azure the *deployment* is the
 * real model (see the note in `dispatchLlm`), so report that to telemetry rather
 * than the cosmetic dropdown value.
 */
function effectiveModel(opts: LlmCallOptions): string {
  if (opts.provider.provider === 'azure_openai') {
    return opts.provider.deployment?.trim() || opts.model
  }
  return opts.model
}

/** Compact stand-in for "what the model was asked" on the generation span. */
function describeRequest(opts: LlmCallOptions): string {
  const last = opts.messages[opts.messages.length - 1]
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  try {
    return JSON.stringify(last.content)
  } catch {
    return ''
  }
}

/**
 * Call the configured provider, recording the round-trip as a Pendo GENERATION
 * span when a conversation turn is active (see `pendoTracing.ts`).
 */
export async function callLlm(opts: LlmCallOptions): Promise<LlmResponse> {
  const model = effectiveModel(opts)
  return traceGeneration(
    { model, promptText: describeRequest(opts), toolsAvailable: opts.tools },
    () => dispatchLlm(opts),
    (res) => ({
      text: res.textContent,
      model,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      cacheReadTokens: res.usage?.cacheReadTokens,
      toolCalls: res.toolCalls.map(t => t.name)
    })
  )
}

async function dispatchLlm(opts: LlmCallOptions): Promise<LlmResponse> {
  const { provider } = opts

  if (provider.provider === 'anthropic') {
    return callAnthropic(opts)
  } else if (provider.provider === 'openai') {
    return callOpenAi(opts, 'https://api.openai.com/v1/chat/completions', provider.apiKey!)
  } else if (provider.provider === 'azure_openai') {
    // For Azure the *deployment* is the real model — the model name picked in
    // the agent UI is cosmetic. Always send the deployment so we hit the model
    // that's actually deployed (e.g. `claude-opus-4-6`), not a stale dropdown
    // value.
    const model = provider.deployment?.trim() || opts.model
    const endpoint = (provider.endpoint || '').trim()

    // Some Azure deployments expose Anthropic's Messages API (Claude models
    // fronted by API Management / AI Foundry) rather than the OpenAI
    // chat-completions surface. Detect that and speak the right protocol to
    // the endpoint as configured — don't graft `/openai/deployments/...` onto
    // a URL that's already a `/v1/messages` endpoint.
    if (usesAnthropicProtocol(provider)) {
      // The endpoint *is* the destination here — there is no public-API
      // fallback for Azure. Guard explicitly so a misconfigured (blank)
      // endpoint fails loudly instead of silently shipping the gateway key off
      // to api.anthropic.com.
      if (!endpoint) {
        throw new Error('Azure provider resolves to an Anthropic Messages endpoint but no endpoint is configured.')
      }
      return callAnthropic({ ...opts, model }, {
        url: endpoint,
        // Cover both the Azure API Management convention (`api-key`) and
        // Anthropic's native header (`x-api-key`) so either gateway policy
        // authenticates.
        authHeaders: { 'api-key': provider.apiKey!, 'x-api-key': provider.apiKey! },
        disableCaching: true
      })
    }

    const url = `${endpoint}/openai/deployments/${provider.deployment}/chat/completions?api-version=${provider.apiVersion}`
    return callOpenAi({ ...opts, model }, url, provider.apiKey!, true)
  }

  throw new Error(`Unsupported provider: ${provider.provider}`)
}

/**
 * True when an Azure provider should be called with Anthropic's Messages API
 * instead of OpenAI chat-completions. Triggered by an Anthropic-shaped
 * endpoint path (`/anthropic`, or a `…/v1/messages` URL) or a Claude
 * deployment name.
 */
function isAnthropicStyleAzure(endpoint: string, model: string): boolean {
  const e = endpoint.toLowerCase()
  return (
    e.includes('/anthropic') ||
    e.endsWith('/v1/messages') ||
    e.endsWith('/messages') ||
    /^claude[-.]?/i.test(model.trim())
  )
}

/**
 * The single source of truth for "is this provider driven over Anthropic's
 * Messages API?" — true for a native Anthropic provider, or an Azure
 * deployment that fronts the Messages API. Both the request path (`callLlm`)
 * and the conversation-history builder (`appendToolResults`) MUST agree on
 * this: if they disagree, a tool-using turn gets stored in OpenAI wire format
 * but replayed to `callAnthropic` (or vice versa), and the agent loop breaks
 * on its second iteration. Keyed off provider config only (endpoint +
 * deployment) so both call sites compute the same answer.
 */
export function usesAnthropicProtocol(provider: ProviderConfig): boolean {
  if (provider.provider === 'anthropic') return true
  if (provider.provider === 'azure_openai') {
    return isAnthropicStyleAzure((provider.endpoint || '').trim(), provider.deployment?.trim() || '')
  }
  return false
}

interface AnthropicTransport {
  /** Full URL to POST to. Defaults to Anthropic's public Messages API. */
  url?: string
  /** Auth headers to send instead of the default `x-api-key`. */
  authHeaders?: Record<string, string>
  /** Skip prompt-caching (blocks + beta header) — gateways that proxy the
   *  Messages API may reject the unknown `cache_control` field / beta header. */
  disableCaching?: boolean
}

async function callAnthropic(opts: LlmCallOptions, transport: AnthropicTransport = {}): Promise<LlmResponse> {
  const { provider, systemPrompt, messages, tools, maxTokens, onTextDelta } = opts
  const model = opts.model
  const useCaching = !transport.disableCaching

  // Split the system prompt at the FIRST `\n\n---\n\n` separator. Everything
  // before it (Layer 1: the static reference docs, skill, examples) gets sent
  // with `cache_control: ephemeral` so Anthropic returns a cache hit on the
  // big static prefix. Everything after — notebook context, current time,
  // segment, app id, additional instructions — is sent UNCACHED so per-turn
  // freshness (today's date, recent cell summary, etc.) takes effect every
  // request without invalidating the cached prefix.
  //
  // `buildSystemPrompt` in `systemPrompt.ts` is the producer; if you add new
  // sections, place anything time-sensitive AFTER the first separator.
  const sep = '\n\n---\n\n'
  const sepIdx = systemPrompt.indexOf(sep)
  const layer1 = sepIdx > -1 ? systemPrompt.slice(0, sepIdx) : systemPrompt
  const dynamic = sepIdx > -1 ? systemPrompt.slice(sepIdx + sep.length) : ''

  let body: any
  if (useCaching) {
    const systemBlocks: any[] = [
      { type: 'text', text: layer1, cache_control: { type: 'ephemeral' } }
    ]
    if (dynamic) {
      systemBlocks.push({ type: 'text', text: dynamic })
    }
    body = { model, max_tokens: maxTokens, system: systemBlocks, messages: anthropicMessagesToApi(messages), stream: true }
  } else {
    // No cache_control blocks — send the system prompt as a single string so a
    // proxying gateway doesn't choke on the caching extension.
    body = { model, max_tokens: maxTokens, system: systemPrompt, messages: anthropicMessagesToApi(messages), stream: true }
  }
  if (tools.length > 0) {
    body.tools = toAnthropicTools(tools)
  }

  const url = transport.url || 'https://api.anthropic.com/v1/messages'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(useCaching ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
    ...(transport.authHeaders ?? { 'x-api-key': provider.apiKey! })
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${err}`)
  }

  let textContent = ''
  const toolCalls: ToolCall[] = []
  let stopReason = 'end_turn'
  const usage: LlmUsage = {}
  const pendingToolCalls: Map<number, { id: string; name: string; inputBuf: string }> = new Map()

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue
      try {
        const ev = JSON.parse(data)
        if (ev.type === 'message_start') {
          // Prompt-side accounting arrives once, up front.
          const u = ev.message?.usage
          if (u) {
            if (u.input_tokens != null) usage.inputTokens = u.input_tokens
            if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
            if (u.output_tokens != null) usage.outputTokens = u.output_tokens
          }
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta?.stop_reason ?? stopReason
          // Completion tokens are only final on the closing delta.
          if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens
        } else if (ev.type === 'content_block_start') {
          const blk = ev.content_block
          if (blk?.type === 'tool_use') {
            pendingToolCalls.set(ev.index, { id: blk.id, name: blk.name, inputBuf: '' })
          }
        } else if (ev.type === 'content_block_delta') {
          const delta = ev.delta
          if (delta?.type === 'text_delta') {
            textContent += delta.text
            onTextDelta(delta.text)
          } else if (delta?.type === 'input_json_delta') {
            const pending = pendingToolCalls.get(ev.index)
            if (pending) pending.inputBuf += delta.partial_json
          }
        }
      } catch { /* skip malformed */ }
    }
  }

  for (const [, tc] of pendingToolCalls) {
    try {
      toolCalls.push({ id: tc.id, name: tc.name, args: JSON.parse(tc.inputBuf || '{}') })
    } catch {
      toolCalls.push({ id: tc.id, name: tc.name, args: {} })
    }
  }

  return { textContent, toolCalls, stopReason, usage }
}

async function callOpenAi(opts: LlmCallOptions, url: string, apiKey: string, isAzure = false): Promise<LlmResponse> {
  const { model, systemPrompt, messages, tools, maxTokens, onTextDelta } = opts

  const apiMessages: any[] = [
    { role: 'system', content: systemPrompt },
    ...openAiMessagesToApi(messages)
  ]

  const body: any = {
    model,
    messages: apiMessages,
    max_tokens: maxTokens,
    stream: true
  }
  if (tools.length > 0) {
    body.tools = toOpenAiTools(tools)
    body.tool_choice = 'auto'
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isAzure) {
    headers['api-key'] = apiKey
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${err}`)
  }

  let textContent = ''
  const pendingCalls: Map<number, { id: string; name: string; argsBuf: string }> = new Map()
  let stopReason = 'stop'
  const usage: LlmUsage = {}

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue
      try {
        const ev = JSON.parse(data)
        // Usage rides on its own trailing chunk with an empty `choices` array,
        // so read it before the guard below skips that chunk. Only deployments
        // that opt into usage-on-stream send it; absence is normal.
        if (ev.usage) {
          if (ev.usage.prompt_tokens != null) usage.inputTokens = ev.usage.prompt_tokens
          if (ev.usage.completion_tokens != null) usage.outputTokens = ev.usage.completion_tokens
          if (ev.usage.prompt_tokens_details?.cached_tokens != null) {
            usage.cacheReadTokens = ev.usage.prompt_tokens_details.cached_tokens
          }
        }
        const choice = ev.choices?.[0]
        if (!choice) continue
        stopReason = choice.finish_reason ?? stopReason
        const delta = choice.delta
        if (delta?.content) {
          textContent += delta.content
          onTextDelta(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!pendingCalls.has(idx)) {
              pendingCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', argsBuf: '' })
            }
            const pending = pendingCalls.get(idx)!
            if (tc.id) pending.id = tc.id
            if (tc.function?.name) pending.name = tc.function.name
            if (tc.function?.arguments) pending.argsBuf += tc.function.arguments
          }
        }
      } catch { /* skip malformed */ }
    }
  }

  const toolCalls: ToolCall[] = []
  for (const [, tc] of pendingCalls) {
    try {
      toolCalls.push({ id: tc.id, name: tc.name, args: JSON.parse(tc.argsBuf || '{}') })
    } catch {
      toolCalls.push({ id: tc.id, name: tc.name, args: {} })
    }
  }

  return { textContent, toolCalls, stopReason, usage }
}

// Build the messages array after a tool result turn
export function appendToolResults(
  messages: ConversationMessage[],
  assistantTurn: { textContent: string; toolCalls: ToolCall[] },
  toolResults: Array<{ callId: string; content: string; isError?: boolean }>,
  provider: ProviderConfig
): ConversationMessage[] {
  const next = [...messages]

  if (usesAnthropicProtocol(provider)) {
    const assistantContent: any[] = []
    if (assistantTurn.textContent) {
      assistantContent.push({ type: 'text', text: assistantTurn.textContent })
    }
    for (const tc of assistantTurn.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
    }
    next.push({ role: 'assistant', content: assistantContent })

    const toolResultBlocks = toolResults.map(r => ({
      type: 'tool_result',
      tool_use_id: r.callId,
      content: r.content,
      ...(r.isError ? { is_error: true } : {})
    }))
    next.push({ role: 'tool_result', content: [{ role: 'user', content: toolResultBlocks }] })
  } else {
    // OpenAI format
    const assistantMsg: any = { role: 'assistant', content: assistantTurn.textContent || null }
    if (assistantTurn.toolCalls.length > 0) {
      assistantMsg.tool_calls = assistantTurn.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) }
      }))
    }
    next.push({ role: 'assistant', content: assistantMsg })

    const toolMsgs = toolResults.map(r => ({
      role: 'tool' as const,
      tool_call_id: r.callId,
      content: r.content
    }))
    next.push({ role: 'tool_result', content: toolMsgs })
  }

  return next
}
