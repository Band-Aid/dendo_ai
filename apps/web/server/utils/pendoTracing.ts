/**
 * Pendo Agent Analytics instrumentation.
 *
 * Sends this app's agent conversations (user prompts, agent responses) and the
 * traces behind them (LLM generations, tool calls) to Pendo Agent Analytics via
 * `pendo-server-sdk`.
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN THE SDK'S "AUTOMATIC" PATHS
 * ---------------------------------------------------------------
 * The SDK captures traces automatically in exactly three situations: an
 * OpenTelemetry SDK is already running, LangChain is in use, or one of the
 * official vendor clients (`@anthropic-ai/sdk`, `openai`, `@google/genai`) is
 * loaded so its auto-patcher can hook it. None of those apply here — `llmClient.ts`
 * talks to the Messages / chat-completions APIs over raw `fetch`, and there is no
 * LangChain or OTel in the tree. So we emit the SDK's span schema directly,
 * mirroring the SDK's own manual integration (`traceClaudeQuery`), which exists
 * for this same reason: an agent whose LLM traffic the patchers cannot reach.
 *
 * We also avoid the SDK's `traceLlm()` decorator on purpose. It opens a fresh
 * `conversation.turn` root — and therefore a *new prompt + response pair* — on
 * every top-level call where a conversation id is resolvable. Our agent loop
 * calls the LLM up to 12 times per user turn, so that would report a dozen
 * separate conversations per question. `withAgentTurn()` below owns the turn
 * boundary instead: one prompt, one response, with every generation and tool
 * call nested underneath as trace spans.
 *
 * SPAN SHAPE (what the exporter turns each of these into)
 *   conversation.turn  role=system  -> suppressed; groups the trace
 *     user.prompt      USER_MESSAGE -> `prompt` conversation event
 *     llm.generation   GENERATION   -> `generation` trace observation
 *     tool.<name>      TOOL_REQUEST -> `tool_request` trace observation
 *     agent.response   ASSISTANT_RESPONSE -> `agent_response` conversation event
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context, Span } from '@opentelemetry/api'
import type { ReactionTypeValue } from 'pendo-server-sdk'
import { getOrgById } from '~/server/utils/orgStore'

/**
 * Both of these are loaded through `createRequire` rather than `import`, the
 * same trick `server/db/client.ts` uses for `node:sqlite`.
 *
 * `pendo-server-sdk` is CommonJS (no `type: module`, no `exports` map) and its
 * dist files require each other without file extensions (`require("./core")`).
 * Nitro's dev bundler inlines the package and rewrites those into extensionless
 * ESM imports, which Node's ESM loader rejects — and because the failure is at
 * the top of the shared dev bundle it takes down *every* API route, not just
 * the traced ones. `nitro.externals.external` does not prevent the inlining in
 * dev. Requiring it keeps the bundler out of the picture entirely.
 *
 * `@opentelemetry/api` comes through the same require so that this module and
 * the SDK share one physical copy, and therefore one tracer registry. (The OTel
 * API also de-dupes via a `globalThis` symbol, so this is belt-and-braces.)
 */
const nodeRequire = createRequire(import.meta.url)
const { trace, context: otelContext, SpanStatusCode } =
  nodeRequire('@opentelemetry/api') as typeof import('@opentelemetry/api')
const {
  init: pendoInit,
  flush: pendoFlush,
  recordReaction
} = nodeRequire('pendo-server-sdk') as typeof import('pendo-server-sdk')

/** Conversation content is capped so a huge prompt or answer can't bloat a span. */
const MAX_CONTENT_CHARS = 8_000
/** Tool payloads are noisier and less useful in full — capped tighter. */
const MAX_TOOL_CHARS = 4_000

const TRACER_NAME = 'dendo'

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`
}

function stringify(value: unknown, max: number): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })()
  return truncate(text, max)
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

type InitState = 'pending' | 'enabled' | 'disabled'
let initState: InitState = 'pending'

interface PendoAgentConfig {
  apiKey: string
  agentId: string
  endpoint: string
  enabled: boolean
  redact: boolean
  defaultVisitorId: string
  defaultAccountId: string
}

function readConfig(): PendoAgentConfig {
  const cfg = useRuntimeConfig().pendoAgent as Partial<PendoAgentConfig> | undefined
  return {
    apiKey: cfg?.apiKey ?? '',
    agentId: cfg?.agentId ?? '',
    endpoint: cfg?.endpoint || 'https://app.pendo.io',
    enabled: cfg?.enabled !== false,
    redact: cfg?.redact === true,
    defaultVisitorId: cfg?.defaultVisitorId ?? '',
    defaultAccountId: cfg?.defaultAccountId ?? ''
  }
}

/**
 * Initialize the SDK once per process. Returns false when tracing is switched
 * off or unconfigured, in which case every helper here degrades to a pass-through.
 *
 * `init()` warns and ignores repeat calls, so the `initState` latch keeps dev
 * hot-reloads quiet.
 */
function ensureInitialized(): boolean {
  if (initState !== 'pending') return initState === 'enabled'

  let config: PendoAgentConfig
  try {
    config = readConfig()
  } catch {
    // useRuntimeConfig() outside a Nitro context — nothing we can do.
    initState = 'disabled'
    return false
  }

  if (!config.enabled || !config.apiKey || !config.agentId) {
    initState = 'disabled'
    return false
  }

  try {
    pendoInit({
      apiKey: config.apiKey,
      agentId: config.agentId,
      endpoint: config.endpoint,
      redact: config.redact,
      // Nothing to patch: all LLM traffic goes out over raw `fetch`, and
      // patching libraries we don't call would only add startup risk.
      autoPatch: false
    })
    initState = 'enabled'
    return true
  } catch (err: any) {
    console.error('[pendo] tracing disabled — init failed:', err?.message ?? err)
    initState = 'disabled'
    return false
  }
}

/** True when spans are actually being emitted. Exposed for health/debug output. */
export function isPendoTracingEnabled(): boolean {
  return ensureInitialized()
}

/**
 * Tell the exporter up front that this turn's root emits no event of its own.
 *
 * The exporter recognises a suppressed root only when it processes the root
 * span — but spans reach it in completion order, so every child is exported
 * first and stamps `agentParentSpanId` pointing at a span that never produces an
 * observation. Registering the id at turn start means children blank the field
 * instead and attach cleanly at the top of the trace. The SDK's own decorators
 * do exactly this in `startTurnRoot`.
 *
 * `_getExporter` is SDK-internal, so this is best-effort: if a future version
 * moves it, traces stay correct apart from that dangling parent reference.
 */
function markRootSuppressed(spanId: string): void {
  try {
    const core = nodeRequire('pendo-server-sdk/dist/core') as {
      _getExporter?: () => { _recordSuppressedRoot?: (id: string) => void } | undefined
    }
    core._getExporter?.()?._recordSuppressedRoot?.(spanId)
  } catch {
    // Never worth breaking a turn over.
  }
}

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

interface TurnState {
  root: Span
  parentCtx: Context
  conversationId: string
  visitorId: string
  accountId: string
  responseMessageId: string
  /** Last model that actually served a generation in this turn. */
  model: string
  toolsUsed: Set<string>
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  sawUsage: boolean
}

const turnStorage = new AsyncLocalStorage<TurnState>()

/**
 * The span new child spans should hang off, when it isn't the turn root.
 *
 * We carry this ourselves instead of using OTel's `context.with()` because the
 * SDK builds its pipeline on `@opentelemetry/sdk-trace-base`, which registers no
 * async-aware context manager — `context.active()` would not survive an `await`.
 * (The SDK's own decorators keep private AsyncLocalStorages for exactly this
 * reason.) An `AsyncLocalStorage` holding the context does propagate correctly.
 *
 * Deliberately separate from `turnStorage` so nesting never has to clone
 * `TurnState`: the token counters and `toolsUsed` set are mutated in place, and
 * a shallow copy per nesting level would silently drop those rollups.
 */
const parentCtxStorage = new AsyncLocalStorage<Context>()

function currentTurn(): TurnState | undefined {
  return turnStorage.getStore()
}

/** Where a new child span attaches: the innermost open span, else the turn root. */
function activeParentContext(turn: TurnState): Context {
  return parentCtxStorage.getStore() ?? turn.parentCtx
}

/** Run `fn` with `span` as the parent for anything traced inside it. */
function runUnderSpan<T>(span: Span, parentCtx: Context, fn: () => Promise<T>): Promise<T> {
  return parentCtxStorage.run(trace.setSpan(parentCtx, span), fn)
}

function stampIdentity(span: Span, turn: TurnState): void {
  span.setAttribute('pendo.conversation_id', turn.conversationId)
  if (turn.visitorId) span.setAttribute('pendo.visitor_id', turn.visitorId)
  if (turn.accountId) span.setAttribute('pendo.account_id', turn.accountId)
}

export interface AgentTurnOptions {
  /** Groups every turn of one thread. Must be stable across turns. */
  conversationId: string
  /** The user's message — becomes the `prompt` conversation event. */
  prompt: string
  visitorId: string
  accountId: string
  /** Marks the prompt as a click on a pre-built prompt rather than typed text. */
  suggestedPrompt?: boolean
  /**
   * Id to report this turn's answer under. Pass the id the UI already uses for
   * the message (the persisted chat message id) so later interactions with that
   * answer can be attributed to it. Defaults to a fresh UUID.
   */
  responseMessageId?: string
  /** Free-form properties stamped on every event of this turn. */
  eventProperties?: Record<string, unknown>
  /**
   * Receives the id assigned to this turn's agent_response. Pass it back to
   * `recordAgentReaction()` to attach a thumbs-up/down to this exact message.
   */
  onResponseMessageId?: (messageId: string) => void
}

/**
 * Run one user turn as a Pendo conversation: emits the user's prompt up front,
 * nests every generation and tool call from `fn` beneath a shared trace root,
 * then emits the agent's answer.
 *
 * Pass-through (no tracing overhead, no behavior change) when tracing is off.
 */
export async function withAgentTurn<T>(
  options: AgentTurnOptions,
  fn: () => Promise<T>,
  resolveResponseText: (result: T) => string
): Promise<T> {
  if (!ensureInitialized()) return fn()

  const tracer = trace.getTracer(TRACER_NAME)
  const root = tracer.startSpan('conversation.turn')
  // role=system + this exact span name is the exporter's contract for "root
  // that groups a turn but emits no event of its own".
  root.setAttribute('pendo.span.type', 'AGENT')
  root.setAttribute('message.role', 'system')
  markRootSuppressed(root.spanContext().spanId)

  const turn: TurnState = {
    root,
    parentCtx: trace.setSpan(otelContext.active(), root),
    conversationId: options.conversationId,
    visitorId: options.visitorId,
    accountId: options.accountId,
    responseMessageId: options.responseMessageId || randomUUID(),
    model: '',
    toolsUsed: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    sawUsage: false
  }

  const eventProperties = options.eventProperties
    ? stringify(options.eventProperties, MAX_CONTENT_CHARS)
    : ''
  if (eventProperties) root.setAttribute('pendo.event_properties', eventProperties)
  stampIdentity(root, turn)

  options.onResponseMessageId?.(turn.responseMessageId)

  emitPromptSpan(tracer, turn, options, eventProperties)

  try {
    const result = await turnStorage.run(turn, fn)
    emitResponseSpan(tracer, turn, resolveResponseText(result), eventProperties)
    root.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (err: any) {
    // Still emit what the user saw — a failed turn is a real conversation
    // outcome, and dropping it would silently under-report errors.
    emitResponseSpan(tracer, turn, `[error] ${err?.message ?? String(err)}`, eventProperties, true)
    root.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) })
    throw err
  } finally {
    root.end()
    try {
      pendoFlush()
    } catch {
      // Never let telemetry export break a request.
    }
  }
}

function emitPromptSpan(
  tracer: ReturnType<typeof trace.getTracer>,
  turn: TurnState,
  options: AgentTurnOptions,
  eventProperties: string
): void {
  const span = tracer.startSpan('user.prompt', undefined, turn.parentCtx)
  span.setAttribute('pendo.span.type', 'USER_MESSAGE')
  span.setAttribute('message.role', 'user')
  span.setAttribute('message.content', truncate(options.prompt, MAX_CONTENT_CHARS))
  span.setAttribute('pendo.message_id', randomUUID())
  if (options.suggestedPrompt) span.setAttribute('message.suggested_prompt', true)
  if (eventProperties) span.setAttribute('pendo.event_properties', eventProperties)
  stampIdentity(span, turn)
  span.end()
}

function emitResponseSpan(
  tracer: ReturnType<typeof trace.getTracer>,
  turn: TurnState,
  text: string,
  eventProperties: string,
  errored = false
): void {
  const span = tracer.startSpan('agent.response', undefined, turn.parentCtx)
  span.setAttribute('pendo.span.type', 'ASSISTANT_RESPONSE')
  span.setAttribute('message.role', 'assistant')
  const content = truncate(text || '', MAX_CONTENT_CHARS)
  span.setAttribute('message.content', content)
  span.setAttribute('message.response_content', content)
  span.setAttribute('pendo.message_id', turn.responseMessageId)
  if (turn.model) span.setAttribute('llm.model_name', turn.model)
  // The exporter splits this on commas to populate the "tools used" widget.
  if (turn.toolsUsed.size > 0) span.setAttribute('tool.name', [...turn.toolsUsed].join(','))
  if (turn.sawUsage) {
    span.setAttribute('pendo.input_token_count', turn.inputTokens)
    span.setAttribute('pendo.output_token_count', turn.outputTokens)
    span.setAttribute('pendo.total_token_count', turn.inputTokens + turn.outputTokens)
    if (turn.cacheReadTokens > 0) {
      span.setAttribute('pendo.cache_read_token_count', turn.cacheReadTokens)
    }
  }
  if (eventProperties) span.setAttribute('pendo.event_properties', eventProperties)
  stampIdentity(span, turn)
  if (errored) span.setStatus({ code: SpanStatusCode.ERROR })
  span.end()
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

export interface GenerationOutcome {
  text?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** Names of the tools this generation asked to call. */
  toolCalls?: string[]
}

export interface GenerationOptions {
  model: string
  /** The request the model saw — stored as the span's trace content. */
  promptText?: string
  /** Catalog of tools offered to the model; drives the "tools available" rollup. */
  toolsAvailable?: Array<{ name: string; description?: string }>
}

/**
 * Record one LLM round-trip as a GENERATION span nested in the active turn.
 *
 * Outside a turn (background/utility LLM calls such as concept evolution) this
 * is a pass-through: those aren't part of a conversation, and emitting them
 * would attach stray generations to whatever conversation ran last.
 */
export async function traceGeneration<T>(
  options: GenerationOptions,
  fn: () => Promise<T>,
  outcome: (result: T) => GenerationOutcome
): Promise<T> {
  const turn = currentTurn()
  if (!turn) return fn()

  const tracer = trace.getTracer(TRACER_NAME)
  const parentCtx = activeParentContext(turn)
  const span = tracer.startSpan('llm.generation', undefined, parentCtx)
  span.setAttribute('pendo.span.type', 'GENERATION')
  // Deliberately NO `message.role` here. The exporter turns *any* span carrying
  // role=assistant into an `agent_response` conversation event, so tagging the
  // per-iteration generations that way reports one "answer" per loop iteration
  // — including an empty one for the tool-call-only iterations. The GENERATION
  // span type alone already yields the llm_request/llm_response trace pair;
  // `agent.response` (emitted once, in emitResponseSpan) owns the turn's answer.
  if (options.model) span.setAttribute('llm.model_name', options.model)
  if (options.promptText) {
    span.setAttribute('message.trace_content', truncate(options.promptText, MAX_CONTENT_CHARS))
  }
  if (options.toolsAvailable?.length) {
    span.setAttribute(
      'llm.tools_available',
      stringify(
        options.toolsAvailable.map(t => ({ name: t.name, description: t.description ?? '' })),
        MAX_CONTENT_CHARS
      )
    )
  }
  stampIdentity(span, turn)

  try {
    const result = await runUnderSpan(span, parentCtx, fn)
    const info = outcome(result)

    const model = info.model || options.model
    if (model) {
      span.setAttribute('llm.model_name', model)
      turn.model = model
    }
    if (info.text) {
      span.setAttribute('message.response_content', truncate(info.text, MAX_CONTENT_CHARS))
    }
    if (info.inputTokens != null) {
      span.setAttribute('llm.token_count.prompt', info.inputTokens)
      turn.inputTokens += info.inputTokens
      turn.sawUsage = true
    }
    if (info.outputTokens != null) {
      span.setAttribute('llm.token_count.completion', info.outputTokens)
      turn.outputTokens += info.outputTokens
      turn.sawUsage = true
    }
    if (info.inputTokens != null && info.outputTokens != null) {
      span.setAttribute('llm.token_count.total', info.inputTokens + info.outputTokens)
    }
    if (info.cacheReadTokens != null) turn.cacheReadTokens += info.cacheReadTokens
    if (info.toolCalls?.length) {
      span.setAttribute('llm.tools_used', stringify(info.toolCalls, MAX_TOOL_CHARS))
      span.setAttribute('tool.name', info.toolCalls.join(','))
    }
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) })
    throw err
  } finally {
    span.end()
  }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  output?: unknown
  /** Set for tools that report failure by returning an error rather than throwing. */
  error?: string
  /** Extra span attributes, for detail that doesn't fit input/output. */
  attributes?: Record<string, string | number | boolean>
}

/**
 * Record one tool execution as a TOOL_REQUEST span nested in the active turn.
 * Pass-through outside a turn, same reasoning as `traceGeneration`.
 */
export async function traceToolCall<T>(
  options: { name: string; input?: unknown },
  fn: () => Promise<T>,
  outcome: (result: T) => ToolOutcome
): Promise<T> {
  const turn = currentTurn()
  if (!turn) return fn()

  turn.toolsUsed.add(options.name)

  const tracer = trace.getTracer(TRACER_NAME)
  const parentCtx = activeParentContext(turn)
  const span = tracer.startSpan(`tool.${options.name}`, undefined, parentCtx)
  span.setAttribute('pendo.span.type', 'TOOL_REQUEST')
  span.setAttribute('tool.name', options.name)
  if (options.input !== undefined) {
    span.setAttribute('tool.input', stringify(options.input, MAX_TOOL_CHARS))
  }
  stampIdentity(span, turn)

  try {
    const result = await runUnderSpan(span, parentCtx, fn)
    const info = outcome(result)
    if (info.output !== undefined) {
      span.setAttribute('tool.output', stringify(info.output, MAX_TOOL_CHARS))
    }
    for (const [key, value] of Object.entries(info.attributes ?? {})) {
      span.setAttribute(key, value)
    }
    if (info.error) {
      span.setAttribute('tool.status', 'error')
      span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(info.error, 500) })
    } else {
      span.setAttribute('tool.status', 'success')
      span.setStatus({ code: SpanStatusCode.OK })
    }
    return result
  } catch (err: any) {
    span.setAttribute('tool.status', 'error')
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) })
    throw err
  } finally {
    span.end()
  }
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Emit a thumbs-up / thumbs-down (or copy / retry / edit) against a message.
 *
 * `messageId` must be the id handed to `AgentTurnOptions.onResponseMessageId`
 * for the message being reacted to — that pairing is what lets Pendo attach the
 * reaction to the right answer.
 */
export function recordAgentReaction(options: {
  conversationId: string
  messageId: string
  reactionType: ReactionTypeValue
  visitorId: string
  accountId: string
  feedbackComment?: string
}): boolean {
  if (!ensureInitialized()) return false
  try {
    recordReaction({
      conversationId: options.conversationId,
      messageId: options.messageId,
      reactionType: options.reactionType,
      visitorId: options.visitorId,
      accountId: options.accountId,
      feedbackComment: options.feedbackComment
    })
    pendoFlush()
    return true
  } catch (err: any) {
    console.error('[pendo] failed to record reaction:', err?.message ?? err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The visitor Dendo reports when nothing more specific is known: the
 * workspace's slug suffixed with `_user_turn` (e.g. `acme-corp_user_turn`).
 *
 * "Workspace" is the user-facing name for an Organization — the entity behind
 * `orgId` and the `X-Org-Id` header (see the `settings.workspace` strings in
 * `locales/en.json`, whose new-workspace tooltip reads "New organization").
 * The slug is used rather than the display name because it is already
 * URL-safe: no spaces or casing to trip over in Pendo segments and filters.
 *
 * Falls back to the raw org id when the org isn't in the database — two agent
 * endpoints read `X-Org-Id` directly instead of going through the tenant
 * middleware, so the value isn't guaranteed to resolve.
 */
function workspaceVisitorId(orgId: string): string {
  let slug = orgId
  try {
    slug = getOrgById(orgId)?.slug || orgId
  } catch {
    // DB unavailable — the org id is a good enough stand-in.
  }
  return `${slug}_user_turn`
}

/**
 * Resolve who Pendo should attribute this turn to.
 *
 * Dendo has no end-user login, so the visitor is workspace-derived rather than
 * per-person. Precedence: an explicit `x-pendo-visitor-id` header (set this
 * from your shell app once you have real users) -> the configured default ->
 * `<workspace-slug>_user_turn`. The account is the tenant: the resolved org id,
 * unless overridden in config.
 */
export function resolveTurnIdentity(event: any, orgId: string): {
  visitorId: string
  accountId: string
} {
  const config = (() => {
    try {
      return readConfig()
    } catch {
      return null
    }
  })()

  const headerVisitor = (() => {
    try {
      return getHeader(event, 'x-pendo-visitor-id')?.trim() || ''
    } catch {
      return ''
    }
  })()

  const headerAccount = (() => {
    try {
      return getHeader(event, 'x-pendo-account-id')?.trim() || ''
    } catch {
      return ''
    }
  })()

  const resolvedOrgId = orgId || 'default'

  return {
    visitorId: headerVisitor || config?.defaultVisitorId || workspaceVisitorId(resolvedOrgId),
    accountId: headerAccount || config?.defaultAccountId || resolvedOrgId
  }
}
