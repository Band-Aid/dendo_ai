import { callLlm, appendToolResults, type ConversationMessage, type LlmResponse } from '~/server/utils/llmClient'
import { executeTool } from '~/server/utils/toolRegistry'
import type { ProviderConfig } from '~/server/utils/adminStore'
import type { UnifiedTool } from '~/server/utils/llmClient'
import type { McpServerConfig } from '~/types/mcp'

const MAX_TOOL_RESULT_CHARS = 12_000
const MAX_ITERATIONS = 12
const MAX_AGG_CALLS = 8

export interface AgentLoopConfig {
  provider: ProviderConfig
  model: string
  systemPrompt: string
  messages: ConversationMessage[]
  tools: UnifiedTool[]
  maxTokens: number
  orgId: string
  sessionId: string
  mcpConfigs: McpServerConfig[]
  /** Notebook-level default segment applied to all run_pendo_aggregation calls (unless the DSL overrides). */
  defaultSegmentId?: string | null
  onTextDelta: (text: string) => void
  onToolStart: (tool: string, explanation?: string) => void
  onToolEnd: (tool: string, success: boolean, rowCount?: number, truncated?: boolean) => void
  onDone: (reason: 'finish' | 'limit' | 'error') => void
}

export interface SummaryChartSpec {
  title: string
  chartType: 'bar' | 'line' | 'donut'
  xAxisLabel?: string
  yAxisLabel?: string
  series: Array<{ name: string; points: Array<{ label: string; value: number }> }>
  explanation?: string
}

export interface AgentLoopResult {
  messages: ConversationMessage[]
  aggregationResults: Array<{
    dsl: string
    rows: Record<string, unknown>[]
    columns: string[]
    explanation?: string
  }>
  summaryCharts: SummaryChartSpec[]
  textContent: string
}

function truncateToolResult(result: unknown): { text: string; truncated: boolean } {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  if (text.length <= MAX_TOOL_RESULT_CHARS) return { text, truncated: false }
  const truncated = text.slice(0, MAX_TOOL_RESULT_CHARS)
  return { text: truncated + '\n[...truncated for length]', truncated: true }
}

export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    provider, model, systemPrompt, tools, maxTokens,
    orgId, sessionId, mcpConfigs, defaultSegmentId,
    onTextDelta, onToolStart, onToolEnd, onDone
  } = config

  let messages: ConversationMessage[] = [...config.messages]
  let iteration = 0
  let aggCallCount = 0
  let totalTextContent = ''
  const aggregationResults: AgentLoopResult['aggregationResults'] = []
  const summaryCharts: SummaryChartSpec[] = []

  while (iteration < MAX_ITERATIONS) {
    iteration++

    let response: LlmResponse
    try {
      response = await callLlm({
        provider,
        model,
        systemPrompt,
        messages,
        tools,
        maxTokens,
        onTextDelta: (t) => {
          totalTextContent += t
          onTextDelta(t)
        }
      })
    } catch (err: any) {
      onDone('error')
      throw err
    }

    // Nothing more to do — agent finished naturally
    if (response.toolCalls.length === 0) {
      messages = appendToolResults(
        messages,
        { textContent: response.textContent, toolCalls: [] },
        [],
        provider
      )
      onDone('finish')
      break
    }

    // Append the assistant turn before executing tools
    // (appendToolResults handles this, but we need results first)
    const toolResults: Array<{ callId: string; content: string; isError?: boolean }> = []

    for (const toolCall of response.toolCalls) {
      const explanation = String((toolCall.args as any).explanation ?? '')
      onToolStart(toolCall.name, explanation)

      let resultContent: string
      let isError = false
      let rowCount: number | undefined
      let truncated = false

      if (toolCall.name === 'run_pendo_aggregation' && aggCallCount >= MAX_AGG_CALLS) {
        resultContent = JSON.stringify({ error: `Aggregation budget exhausted (max ${MAX_AGG_CALLS} per turn)` })
        isError = true
      } else {
        if (toolCall.name === 'run_pendo_aggregation') aggCallCount++

        const { result, error } = await executeTool(
          toolCall.name, toolCall.args, orgId, sessionId, mcpConfigs,
          { defaultSegmentId: defaultSegmentId ?? null }
        )

        if (error) {
          resultContent = JSON.stringify({ error })
          isError = true
        } else {
          const { text, truncated: wasTruncated } = truncateToolResult(result)
          resultContent = text
          truncated = wasTruncated

          // Capture aggregation results for cell creation
          if (toolCall.name === 'run_pendo_aggregation' && result && typeof result === 'object') {
            const r = result as any
            if (r.rows && r.columns) {
              rowCount = r.rowCount ?? r.rows.length
              aggregationResults.push({
                dsl: String(toolCall.args.dsl ?? ''),
                rows: r.rows,
                columns: r.columns,
                explanation: explanation
              })
            }
          }

          // Capture agent-built summary chart specs. The tool registry has
          // already validated the shape and returns { summaryChart: <spec> }.
          if (toolCall.name === 'build_summary_chart' && result && typeof result === 'object') {
            const spec = (result as any).summaryChart
            if (spec) summaryCharts.push(spec as SummaryChartSpec)
          }
        }
      }

      onToolEnd(toolCall.name, !isError, rowCount, truncated)
      toolResults.push({ callId: toolCall.id, content: resultContent, isError })
    }

    // Append assistant turn + tool results into message history
    messages = appendToolResults(messages, response, toolResults, provider)
  }

  if (iteration >= MAX_ITERATIONS) {
    onDone('limit')
  }

  return { messages, aggregationResults, summaryCharts, textContent: totalTextContent }
}
