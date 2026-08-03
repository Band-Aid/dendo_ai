import { ref } from 'vue'
import type { AgentStreamEvent, ChatMessage } from '~/types/notebook'

export interface AgentStreamOptions {
  notebookId: string
  orgId: string
  question: string
  sessionId: string
  referencedCellIds?: string[]
  onMessageCreated: (message: ChatMessage) => void
  onTextDelta: (text: string) => void
  onDone: (reason: string) => void
  onError: (msg: string) => void
}

export function useAgentStream() {
  const streaming = ref(false)
  const streamingText = ref('')
  const currentTool = ref<string | null>(null)
  const toolMessage = ref<string | null>(null)
  let abortController: AbortController | null = null

  async function startStream(opts: AgentStreamOptions) {
    if (streaming.value) return
    streaming.value = true
    streamingText.value = ''
    currentTool.value = null
    toolMessage.value = null

    abortController = new AbortController()

    try {
      const response = await fetch(`/api/notebooks/${opts.notebookId}/agent/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-org-id': opts.orgId
        },
        body: JSON.stringify({
          question: opts.question,
          sessionId: opts.sessionId,
          referencedCellIds: opts.referencedCellIds ?? []
        }),
        signal: abortController.signal
      })

      if (!response.ok) {
        const text = await response.text()
        opts.onError(text || `HTTP ${response.status}`)
        return
      }

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
          if (!data) continue

          try {
            const ev = JSON.parse(data) as AgentStreamEvent

            if (ev.type === 'text') {
              streamingText.value += ev.text
              opts.onTextDelta(ev.text)
            } else if (ev.type === 'tool_start') {
              currentTool.value = ev.tool
              const label = toolLabel(ev.tool)
              toolMessage.value = ev.explanation ? `${label}: ${ev.explanation}` : label
            } else if (ev.type === 'tool_result') {
              currentTool.value = null
              toolMessage.value = ev.success
                ? (ev.rowCount !== undefined ? `Returned ${ev.rowCount} rows` : 'Done')
                : 'Tool failed'
            } else if (ev.type === 'message_created') {
              opts.onMessageCreated(ev.message)
            } else if (ev.type === 'done') {
              opts.onDone(ev.reason)
            } else if (ev.type === 'error') {
              opts.onError(ev.message)
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        opts.onError(err.message || 'Stream error')
      }
    } finally {
      streaming.value = false
      streamingText.value = ''
      currentTool.value = null
      toolMessage.value = null
      abortController = null
    }
  }

  function abort() {
    abortController?.abort()
    streaming.value = false
  }

  return { streaming, streamingText, currentTool, toolMessage, startStream, abort }
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    run_pendo_aggregation: 'Running query',
    lookup_pendo_segments: 'Looking up segments',
    lookup_pendo_features: 'Looking up features',
    lookup_pendo_pages: 'Looking up pages'
  }
  return labels[tool] ?? tool
}
