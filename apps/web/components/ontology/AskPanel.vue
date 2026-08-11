<script setup lang="ts">
import { ref, watch, h } from 'vue'
import { marked } from 'marked'
import { SendOutlined, SaveOutlined, CloseOutlined } from '@ant-design/icons-vue'
import SaveQuestionModal from './SaveQuestionModal.vue'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'

const { t } = useI18n()
const { currentOrgId } = useOrg()

interface AskResult {
  answer: string
  aggregations: Array<{ dsl: string; rows: Record<string, unknown>[]; columns: string[]; explanation?: string }>
  summaryCharts: unknown[]
  relatedNodeIds: string[]
  runAt: string
}

const props = defineProps<{
  open: boolean
  /** Prefilled question (from a cause/action/entity ask). */
  initialQuestion: string
  /** Map node the ask was launched from. */
  originNodeId?: string | null
  /** Auto-run on open — the point of asking from the map. */
  autoRun?: boolean
}>()
const emit = defineEmits<{
  close: []
  /** Related-subgraph ids for the graph highlight (empty array clears). */
  related: [nodeIds: string[]]
  /** Concepts were auto-enriched by this exchange — parent should reload. */
  evolved: []
}>()

interface EvolvedUpdate {
  conceptId: string
  name: string
  addedMeasures: number
  addedCauses: number
  addedActions: number
}

const question = ref('')
/** True while an IME conversion is open (Japanese/Chinese/Korean input). */
const composing = ref(false)
const running = ref(false)
const result = ref<AskResult | null>(null)
const errorMsg = ref('')
const saveOpen = ref(false)
/** The question the current result actually answered (for save + rerun semantics). */
const answeredQuestion = ref('')
/** Streamed-so-far answer text while the agent runs. */
const streamText = ref('')
/** Current tool activity line ("Running query: …") while the agent runs. */
const toolNote = ref('')
/** Concepts the evolution pass enriched from this exchange. */
const evolvedUpdates = ref<EvolvedUpdate[]>([])
let abortController: AbortController | null = null

watch(() => props.open, (open) => {
  if (!open) {
    abortController?.abort()
    emit('related', [])
    return
  }
  question.value = props.initialQuestion
  result.value = null
  errorMsg.value = ''
  if (props.autoRun && props.initialQuestion.trim()) run()
})

const toolLabels: Record<string, string> = {
  run_pendo_aggregation: 'Running query',
  lookup_pendo_segments: 'Looking up segments',
  lookup_pendo_features: 'Looking up features',
  lookup_pendo_pages: 'Looking up pages'
}

/**
 * The ask endpoint streams SSE (text deltas + tool activity + one final
 * `result`) so the multi-turn agent run renders as it happens instead of a
 * blind spinner. Same wire shapes as the notebook agent stream.
 */
async function run() {
  const q = question.value.trim()
  if (!q || running.value) return
  running.value = true
  errorMsg.value = ''
  result.value = null
  streamText.value = ''
  toolNote.value = ''
  evolvedUpdates.value = []
  abortController = new AbortController()
  try {
    const response = await fetch('/api/ontology/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-org-id': currentOrgId.value },
      body: JSON.stringify({ question: q, originNodeId: props.originNodeId ?? undefined }),
      signal: abortController.signal
    })
    if (!response.ok) {
      throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`)
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
          const ev = JSON.parse(data)
          if (ev.type === 'related') {
            emit('related', ev.nodeIds ?? [])
          } else if (ev.type === 'text') {
            streamText.value += ev.text
            toolNote.value = ''
          } else if (ev.type === 'tool_start') {
            const label = toolLabels[ev.tool] ?? ev.tool
            toolNote.value = ev.explanation ? `${label}: ${ev.explanation}` : label
          } else if (ev.type === 'tool_result') {
            toolNote.value = ev.success
              ? (ev.rowCount !== undefined ? t('ui.ontology.askToolRows', { n: ev.rowCount }) : '')
              : t('ui.ontology.askToolFailed')
          } else if (ev.type === 'result') {
            result.value = ev.result as AskResult
            answeredQuestion.value = q
          } else if (ev.type === 'concepts_evolved') {
            evolvedUpdates.value = ev.updates ?? []
            if (evolvedUpdates.value.length) emit('evolved')
          } else if (ev.type === 'error') {
            errorMsg.value = ev.message || 'Ask failed'
          }
        } catch { /* ignore malformed lines */ }
      }
    }
    if (!result.value && !errorMsg.value) errorMsg.value = 'Ask failed'
  } catch (err: any) {
    if (err.name !== 'AbortError') errorMsg.value = err.message || 'Ask failed'
  } finally {
    running.value = false
    streamText.value = ''
    toolNote.value = ''
    abortController = null
  }
}

function evolvedSummary(u: EvolvedUpdate): string {
  const parts: string[] = []
  if (u.addedMeasures) parts.push(t('ui.ontology.evolvedMeasures', { n: u.addedMeasures }))
  if (u.addedCauses) parts.push(t('ui.ontology.evolvedCauses', { n: u.addedCauses }))
  if (u.addedActions) parts.push(t('ui.ontology.evolvedActions', { n: u.addedActions }))
  return t('ui.ontology.askEvolved', { name: u.name, added: parts.join(' · ') })
}

function renderMarkdown(content: string): string {
  if (!content?.trim()) return ''
  return marked.parse(content) as string
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    // An open IME conversion owns this keystroke — `question` is still the
    // pre-conversion value until `compositionend`. See AgentInputBar.
    if (composing.value || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    run()
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="t('ui.ontology.askTitle')"
    width="480"
    :mask="false"
    @close="emit('close')"
  >
    <template #extra>
      <a-button size="small" type="text" :icon="h(CloseOutlined)" @click="emit('close')" />
    </template>

    <div class="ask-body">
      <a-textarea
        v-model:value="question"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :placeholder="t('ui.ontology.askPlaceholder')"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
      <div class="ask-run-row">
        <span class="ask-hint">{{ t('ui.ontology.askHint') }}</span>
        <a-button
          type="primary"
          :icon="h(SendOutlined)"
          :loading="running"
          :disabled="!question.trim()"
          @click="run"
        >{{ t('ui.ontology.askRun') }}</a-button>
      </div>

      <p v-if="errorMsg" class="ask-error">{{ errorMsg }}</p>
      <!-- Pre-result only: once `result` lands the stream stays open a few
           more seconds for concept evolution — the answer must not wait. -->
      <template v-if="running && !result">
        <!-- Streamed answer renders as it arrives; the status line below it
             tracks tool activity between text bursts. -->
        <div v-if="streamText" class="ask-answer" v-html="renderMarkdown(streamText)" />
        <div class="ask-running">
          <a-spin size="small" /> {{ toolNote || t('ui.ontology.askRunning') }}
        </div>
      </template>

      <template v-if="result">
        <div class="ask-answer" v-html="renderMarkdown(result.answer)" />

        <div v-for="(agg, i) in result.aggregations" :key="i" class="ask-agg">
          <div class="ask-agg-head">
            <span class="ask-agg-label">{{ agg.explanation || t('ui.ontology.askResultN', { n: i + 1 }) }}</span>
            <span class="ask-agg-meta mono">{{ agg.rows.length }} rows</span>
          </div>
          <div class="ask-agg-table-wrap">
            <table class="ask-agg-table">
              <thead>
                <tr><th v-for="c in agg.columns" :key="c">{{ c }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, ri) in agg.rows.slice(0, 8)" :key="ri">
                  <td v-for="c in agg.columns" :key="c">{{ r[c] }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="agg.rows.length > 8" class="ask-agg-more">
              +{{ agg.rows.length - 8 }} {{ t('ui.ontology.askMoreRows') }}
            </div>
          </div>
        </div>

        <div v-if="result.relatedNodeIds.length" class="ask-related-note">
          {{ t('ui.ontology.askRelated', { n: result.relatedNodeIds.length }) }}
        </div>

        <!-- What the ontology learned from this exchange (existing concepts
             enriched automatically; new concepts still go through Suggest). -->
        <div v-if="evolvedUpdates.length" class="ask-evolved">
          <div v-for="u in evolvedUpdates" :key="u.conceptId">{{ evolvedSummary(u) }}</div>
        </div>

        <!-- Next step: persist to a notebook, pre-run. -->
        <div class="ask-foot">
          <a-button
            type="primary"
            :icon="h(SaveOutlined)"
            @click="saveOpen = true"
          >{{ t('ui.ontology.askSave') }}</a-button>
        </div>
      </template>
    </div>

    <SaveQuestionModal
      :open="saveOpen"
      :question="answeredQuestion"
      :result="result ? { answer: result.answer, aggregations: result.aggregations, summaryCharts: result.summaryCharts } : null"
      :origin-concept-id="originNodeId"
      @close="saveOpen = false"
    />
  </a-drawer>
</template>

<style scoped>
.ask-body { display: flex; flex-direction: column; gap: 10px; }
.ask-run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ask-hint { font-size: 11px; color: var(--muted, #8a8577); font-style: italic; }
.ask-error {
  color: #a8412b;
  font-family: var(--mono, monospace);
  font-size: 12px;
  margin: 0;
}
.ask-running {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted, #8a8577);
  font-size: 13px;
  padding: 8px 0;
}
.ask-answer {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink, #141513);
}
.ask-answer :deep(p) { margin: 0.35em 0; }
.ask-answer :deep(code) {
  background: var(--subtle, #f5f2ec);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.ask-answer :deep(pre) {
  background: var(--subtle, #f5f2ec);
  padding: 8px 10px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}
.ask-agg {
  border: 1px solid var(--rule, #e5e0d5);
  border-radius: 6px;
  overflow: hidden;
}
.ask-agg-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  background: var(--subtle, #f5f2ec);
  border-bottom: 1px solid var(--rule, #e5e0d5);
}
.ask-agg-label { font-size: 12.5px; font-weight: 600; color: var(--ink, #141513); }
.ask-agg-meta { font-size: 10.5px; color: var(--muted, #8a8577); }
.ask-agg-table-wrap { overflow-x: auto; }
.ask-agg-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.ask-agg-table th {
  text-align: left;
  padding: 4px 8px;
  background: var(--paper, #faf7f2);
  border-bottom: 1px solid var(--rule, #e5e0d5);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted, #8a8577);
  white-space: nowrap;
}
.ask-agg-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--rule, #f0ede6);
  font-family: var(--mono, monospace);
  white-space: nowrap;
}
.ask-agg-more {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--muted, #8a8577);
  font-style: italic;
}
.ask-related-note {
  font-size: 12px;
  color: #a8412b;
  background: rgba(168, 65, 43, 0.07);
  border: 1px solid rgba(168, 65, 43, 0.2);
  border-radius: 6px;
  padding: 6px 10px;
}
.ask-evolved {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: #4d6b42;
  background: rgba(77, 107, 66, 0.07);
  border: 1px solid rgba(77, 107, 66, 0.2);
  border-radius: 6px;
  padding: 6px 10px;
}
.ask-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--rule, #e5e0d5);
}
</style>
