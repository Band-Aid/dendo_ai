<script setup lang="ts">
import { ref, computed, watch, nextTick, h } from 'vue'
import { marked } from 'marked'
import {
  TableOutlined,
  BarChartOutlined,
  AppstoreOutlined,
  PlusOutlined,
  CloseOutlined,
  CodeOutlined,
  QuestionCircleOutlined,
  CloseCircleOutlined,
  DoubleRightOutlined,
  DoubleLeftOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined
} from '@ant-design/icons-vue'
import AgentInputBar from './AgentInputBar.vue'
import ChartRenderer from './ChartRenderer.vue'
import { inferChartConfig } from '~/composables/useChartInference'
import { useI18n } from '~/composables/useI18n'
import type { ChatMessage, ChatAggregation, ChatSummaryChart, NotebookCell } from '~/types/notebook'

const { t } = useI18n()

/**
 * Convert an agent-built summary chart spec into the shape `ChartRenderer`
 * consumes — each summary series becomes one renderer series whose rows
 * are `{ label, value }` pairs derived from the spec's points.
 */
function summaryToRenderer(spec: ChatSummaryChart) {
  return {
    series: spec.series.map(s => ({
      name: s.name,
      rows: s.points.map(p => ({ label: p.label, value: p.value })),
      xField: 'label',
      yField: 'value'
    })),
    xField: 'label',
    yField: 'value'
  }
}

interface ReferencedCellSummary {
  id: string
  label: string
}

interface Props {
  messages: ChatMessage[]
  streaming: boolean
  streamingText: string
  toolMessage: string | null
  referencedCells: ReferencedCellSummary[]
  cellLookup: Record<string, NotebookCell>
  /** When true, sidebar shrinks to a thin rail with just a toggle. Messages and
   * streaming state stay in the component — purely a visibility toggle. */
  collapsed?: boolean
  /** When true, the chat expands to take the entire notebook content area
   *  (notebook cells hide). App nav (left sidebar + topbar) stay visible so
   *  the user can still leave the page. */
  fullscreen?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  send: [question: string]
  abort: []
  addNote: [answer: string, question?: string]
  addQuery: [dsl: string]
  /** Promote this Q&A turn into a re-runnable question cell. Carries the
   *  message so the new cell starts pre-populated with this answer + data. */
  addQuestion: [question: string, msg: ChatMessage]
  addAggregation: [agg: ChatAggregation, mode: 'table' | 'chart' | 'both']
  addAgentSummaryChart: [chart: ChatSummaryChart]
  removeReference: [cellId: string]
  clearChat: []
  toggleCollapse: []
  toggleFullscreen: []
}>()

const scrollEl = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(() => props.messages.length, scrollToBottom)
watch(() => props.streamingText, scrollToBottom)

function renderMarkdown(content: string): string {
  if (!content.trim()) return ''
  return marked.parse(content) as string
}

/**
 * For "Add text to notebook" on an assistant message: find the most recent
 * user message before it so the notebook captures the Q + A pair instead of
 * just the bare answer. Returns undefined when there's nothing reasonable to
 * pair with (first message in chat, etc.).
 */
function questionFor(msg: ChatMessage): string | undefined {
  const idx = props.messages.indexOf(msg)
  if (idx <= 0) return undefined
  for (let i = idx - 1; i >= 0; i--) {
    if (props.messages[i].role === 'user') {
      const c = props.messages[i].content?.trim()
      return c || undefined
    }
  }
  return undefined
}

function aggChartable(agg: ChatAggregation): boolean {
  return !!inferChartConfig(agg.rows, agg.columns)
}

function aggLabel(agg: ChatAggregation, idx: number): string {
  return agg.explanation?.trim() || t('ui.chat.resultLabel', { n: idx + 1 })
}

function refLabel(cellId: string): string {
  const cell = props.cellLookup[cellId]
  if (!cell) return `cell ${cellId.slice(0, 6)}`
  if (cell.cell_type === 'note') {
    const first = (cell.content || '').split('\n')[0].slice(0, 40)
    return first || 'note'
  }
  if (cell.cell_type === 'query') return 'query'
  if (cell.cell_type === 'question') {
    const first = (cell.content || '').split('\n')[0].slice(0, 40)
    return first ? `question: ${first}` : 'question'
  }
  if (cell.cell_type === 'result') return `${(cell.meta_json as any).rowCount ?? '?'}-row result`
  if (cell.cell_type === 'chart') return `chart (${(cell.meta_json as any).title ?? 'untitled'})`
  return cell.cell_type
}
</script>

<template>
  <aside class="chat-sidebar" :class="{ 'is-collapsed': collapsed, 'is-fullscreen': fullscreen && !collapsed }">
    <!-- Collapsed rail: just a vertical strip with an expand button + unread-style cue. -->
    <button
      v-if="collapsed"
      class="chat-rail"
      @click="emit('toggleCollapse')"
      :aria-label="'Expand chat'"
    >
      <component :is="h(DoubleLeftOutlined)" class="chat-rail-icon" />
      <span class="chat-rail-label">Chat</span>
      <span v-if="messages.length" class="chat-rail-count">{{ messages.length }}</span>
    </button>

    <template v-else>
    <div class="sidebar-header">
      <a-tooltip :title="t('ui.chat.collapse')">
        <a-button
          size="small"
          type="text"
          :icon="h(DoubleRightOutlined)"
          @click="emit('toggleCollapse')"
        />
      </a-tooltip>
      <span class="sidebar-title">{{ t('ui.chat.title') }}</span>
      <div class="sidebar-header-actions">
        <a-tooltip :title="fullscreen ? t('ui.chat.exitFullscreen') : t('ui.chat.enterFullscreen')">
          <a-button
            size="small"
            type="text"
            :icon="h(fullscreen ? FullscreenExitOutlined : FullscreenOutlined)"
            @click="emit('toggleFullscreen')"
          />
        </a-tooltip>
        <a-tooltip :title="t('ui.chat.clearTooltip')">
          <a-button
            v-if="messages.length"
            size="small"
            type="text"
            :icon="h(CloseCircleOutlined)"
            @click="emit('clearChat')"
          />
        </a-tooltip>
      </div>
    </div>

    <div ref="scrollEl" class="messages-scroll">
      <div v-if="!messages.length && !streaming" class="empty-state">
        <p>{{ t('ui.chat.empty') }}</p>
      </div>

      <div
        v-for="msg in messages"
        :key="msg.id"
        :class="['msg', msg.role === 'user' ? 'msg-user' : 'msg-assistant']"
      >
        <div v-if="msg.role === 'user'" class="msg-bubble user-bubble">
          <div class="msg-text">{{ msg.content }}</div>
          <div v-if="msg.referenced_cell_ids?.length" class="referenced-chips">
            <span class="ref-chip" v-for="rid in msg.referenced_cell_ids" :key="rid">
              ↳ {{ refLabel(rid) }}
            </span>
          </div>
        </div>

        <div v-else class="msg-bubble assistant-bubble">
          <div class="agent-row">
            <div class="agent-avatar">D</div>
            <span class="agent-name">{{ t('ui.chat.agentName') }}</span>
          </div>

          <div class="msg-markdown" v-html="renderMarkdown(msg.content)" />

          <!-- Action buttons -->
          <div v-if="msg.content?.trim()" class="msg-actions">
            <a-button
              size="small"
              :icon="h(PlusOutlined)"
              @click="emit('addNote', msg.content, questionFor(msg))"
            >{{ t('ui.chat.actions.addNote') }}</a-button>
            <a-button
              v-if="msg.dsl"
              size="small"
              :icon="h(CodeOutlined)"
              @click="emit('addQuery', msg.dsl!)"
            >{{ t('ui.chat.actions.addQuery') }}</a-button>
            <a-button
              v-if="questionFor(msg)"
              size="small"
              :icon="h(QuestionCircleOutlined)"
              @click="emit('addQuestion', questionFor(msg)!, msg)"
            >{{ t('ui.chat.actions.saveQuestion') }}</a-button>
          </div>

          <!-- Aggregation attachments -->
          <div v-if="msg.aggregations?.length" class="attachments">
            <div
              v-for="(agg, idx) in msg.aggregations"
              :key="idx"
              class="attachment"
            >
              <div class="attachment-header">
                <span class="attachment-label">{{ aggLabel(agg, idx) }}</span>
                <span class="attachment-meta">{{ t('ui.chat.rowsLabel', { n: agg.rows.length }) }}</span>
              </div>

              <details class="attachment-details">
                <summary>{{ t('ui.chat.previewToggle') }}</summary>
                <pre class="attachment-dsl">{{ agg.dsl }}</pre>
                <div class="attachment-preview-rows">
                  <table>
                    <thead>
                      <tr><th v-for="c in agg.columns" :key="c">{{ c }}</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="(r, i) in agg.rows.slice(0, 5)" :key="i">
                        <td v-for="c in agg.columns" :key="c">{{ r[c] }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-if="agg.rows.length > 5" class="preview-more">
                    {{ t('ui.chat.moreRows', { n: agg.rows.length - 5 }) }}
                  </div>
                </div>
              </details>

              <div class="attachment-actions">
                <a-button
                  size="small"
                  :icon="h(TableOutlined)"
                  @click="emit('addAggregation', agg, 'table')"
                >{{ t('ui.chat.actions.addTable') }}</a-button>
                <a-button
                  v-if="aggChartable(agg)"
                  size="small"
                  :icon="h(BarChartOutlined)"
                  @click="emit('addAggregation', agg, 'chart')"
                >{{ t('ui.chat.actions.addChart') }}</a-button>
                <a-button
                  v-if="aggChartable(agg)"
                  size="small"
                  type="primary"
                  :icon="h(AppstoreOutlined)"
                  @click="emit('addAggregation', agg, 'both')"
                >{{ t('ui.chat.actions.addBoth') }}</a-button>
              </div>
            </div>
          </div>

          <!--
            Agent-built summary charts — when the model called the explicit
            `build_summary_chart` tool. We render the chart preview inline
            (using ChartRenderer) and offer a single-click action to drop the
            same spec into a notebook chart cell. Distinct from the
            heuristic "Combine into one chart" above because here the model
            already chose the comparison key and metric.
          -->
          <div v-if="msg.summary_charts?.length" class="agent-summary-charts">
            <div
              v-for="(chart, idx) in msg.summary_charts"
              :key="idx"
              class="agent-summary-chart"
            >
              <div class="asc-header">
                <div class="asc-title-block">
                  <span class="eyebrow">{{ t('ui.chart.eyebrow') }}</span>
                  <h4 class="asc-title">{{ chart.title }}</h4>
                </div>
              </div>
              <p v-if="chart.explanation" class="asc-explanation">{{ chart.explanation }}</p>
              <ChartRenderer
                :type="chart.chartType"
                v-bind="summaryToRenderer(chart)"
                :title="''"
              />
              <div class="asc-actions">
                <a-button
                  size="small"
                  type="primary"
                  :icon="h(AppstoreOutlined)"
                  @click="emit('addAgentSummaryChart', chart)"
                >
                  {{ t('ui.chat.actions.addAgentSummary') }}
                </a-button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Streaming -->
      <div v-if="streaming && streamingText" class="msg msg-assistant">
        <div class="msg-bubble assistant-bubble streaming">
          <div class="agent-row">
            <div class="agent-avatar">D</div>
            <span class="agent-name">{{ t('ui.chat.agentName') }}</span>
            <span class="typing-dot" />
          </div>
          <div class="msg-markdown" v-html="renderMarkdown(streamingText)" />
        </div>
      </div>
    </div>

    <div class="input-area">
      <div v-if="referencedCells.length" class="referenced-bar">
        <span class="referenced-label">{{ t('ui.chat.referencing') }}</span>
        <span
          v-for="ref in referencedCells"
          :key="ref.id"
          class="ref-chip removable"
        >
          {{ ref.label }}
          <component
            :is="h(CloseOutlined)"
            class="ref-remove"
            @click="emit('removeReference', ref.id)"
          />
        </span>
      </div>

      <AgentInputBar
        :streaming="streaming"
        :tool-message="toolMessage"
        @send="(q: string) => emit('send', q)"
        @abort="emit('abort')"
      />
    </div>
    </template>
  </aside>
</template>

<style scoped>
.chat-sidebar {
  display: flex;
  flex-direction: column;
  width: 420px;
  min-width: 360px;
  border-left: 1px solid var(--rule);
  background: var(--paper-deep);
  height: 100%;
  font-family: var(--sans);
  transition: width 0.18s ease, min-width 0.18s ease;
}
/* Collapsed rail — keeps state, just shrinks the visible footprint to ~40px
 * so the notebook canvas reclaims most of the right column. */
.chat-sidebar.is-collapsed {
  width: 40px;
  min-width: 40px;
  background: var(--paper);
}
/* Fullscreen — width is driven entirely by the parent layout (the notebook
 * page hides the cells column and stretches the chat to fill the row). We
 * just relax the fixed/min widths so the flex parent owns sizing. */
.chat-sidebar.is-fullscreen {
  width: 100%;
  min-width: 0;
  border-left: none;
  background: var(--paper);
}
/* Wider reading column inside fullscreen so messages don't stretch full-width
 * on large monitors. Keep the chrome (header/input) edge-to-edge. */
.chat-sidebar.is-fullscreen .messages-scroll {
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}
.chat-sidebar.is-fullscreen .input-area > * {
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}
.chat-rail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 16px 0;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-family: var(--sans);
  font-size: 12px;
  letter-spacing: 0.04em;
}
.chat-rail:hover { color: var(--accent); }
.chat-rail-icon { font-size: 14px; }
.chat-rail-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 11px;
}
.chat-rail-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--subtle);
  color: var(--ink-2);
  font-size: 10.5px;
  font-weight: 600;
}
.sidebar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
  flex-shrink: 0;
  gap: 8px;
}
.sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sidebar-title {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 28, 'SOFT' 40;
  font-size: 19px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.sidebar-title::before {
  content: '§';
  font-style: italic;
  color: var(--accent);
  margin-right: 6px;
  font-variation-settings: 'opsz' 28, 'SOFT' 100, 'WONK' 1;
}

.messages-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 18px 18px 20px;
  display: flex; flex-direction: column; gap: 22px;
}
.messages-scroll::-webkit-scrollbar { width: 8px; }
.messages-scroll::-webkit-scrollbar-thumb { background: var(--rule-strong); border-radius: 8px; }

.empty-state { padding: 18px 0; }
.empty-state p {
  color: var(--ink-2) !important;
  font-size: 14.5px !important;
  line-height: 1.6;
  font-family: var(--sans);
}

.msg { display: flex; }
.msg-user { justify-content: flex-end; }
.msg-assistant { justify-content: flex-start; }
.msg-bubble { max-width: 100%; }

.user-bubble {
  background: var(--ink);
  color: var(--paper);
  padding: 10px 14px;
  border-radius: 10px 10px 2px 10px;
  max-width: 88%;
  position: relative;
  box-shadow: 0 1px 0 rgba(20,21,19,0.08);
}
.user-bubble .msg-text {
  white-space: pre-wrap;
  font-size: 14.5px;
  line-height: 1.6;
  font-family: var(--sans);
}

.assistant-bubble { width: 100%; }
.assistant-bubble.streaming { opacity: 0.9; }

.agent-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}
.agent-avatar {
  width: 24px; height: 24px;
  border-radius: 50%;
  background: var(--paper);
  border: 1px solid var(--rule-strong);
  color: var(--accent);
  font-size: 14px;
  font-weight: 500;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 24, 'SOFT' 100, 'WONK' 1;
  display: flex; align-items: center; justify-content: center;
  font-style: italic;
}
.agent-name {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 15px;
  font-style: italic;
  color: var(--ink);
  letter-spacing: -0.005em;
}

.msg-markdown {
  font-size: 15px;
  line-height: 1.65;
  color: var(--ink);
  font-family: var(--sans);
}
.msg-markdown :deep(p) { margin: 0.35em 0; }
.msg-markdown :deep(strong) { color: var(--ink); font-weight: 600; }
.msg-markdown :deep(em) { font-family: var(--serif); font-style: italic; }
.msg-markdown :deep(h1),
.msg-markdown :deep(h2),
.msg-markdown :deep(h3) {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 28, 'SOFT' 40;
  color: var(--ink);
  letter-spacing: -0.01em;
  margin: 0.8em 0 0.3em;
}
.msg-markdown :deep(h1) { font-size: 18px; }
.msg-markdown :deep(h2) { font-size: 16px; }
.msg-markdown :deep(h3) { font-size: 14.5px; }
.msg-markdown :deep(code) {
  background: var(--subtle-2);
  color: var(--ink);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 13.5px;
  font-family: var(--mono);
  border: 1px solid var(--rule);
}
.msg-markdown :deep(pre) {
  /* Light code block (dark theme was too low-contrast for ASCII charts). */
  background: var(--subtle, #F5F2EC);
  color: var(--ink, #1F1A14);
  padding: 12px 14px;
  border-radius: var(--r-md);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.45;
  border: 1px solid var(--rule, #E5E0D5);
  font-family: var(--mono);
  white-space: pre;
  tab-size: 2;
  font-variant-ligatures: none;
  font-feature-settings: 'liga' 0, 'calt' 0;
}
.msg-markdown :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
  font-size: inherit;
  border-radius: 0;
  border: none;
}
.msg-markdown :deep(ul),
.msg-markdown :deep(ol) { padding-left: 20px; margin: 0.4em 0; }
.msg-markdown :deep(li) { margin: 0.2em 0; }
.msg-markdown :deep(blockquote) {
  border-left: 2px solid var(--accent);
  padding: 0 0 0 14px;
  margin: 0.5em 0;
  color: var(--ink-2);
  font-style: italic;
}

.msg-actions {
  display: flex; gap: 6px; flex-wrap: wrap;
  margin-top: 12px;
}

.attachments { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.attachment {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: 12px 14px;
}
.attachment-header {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 8px;
}
.attachment-label {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 20, 'SOFT' 50;
  font-size: 14px;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.attachment-meta {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.attachment-details { font-size: 12px; }
.attachment-details summary {
  cursor: pointer;
  color: var(--muted);
  padding: 4px 0;
  font-size: 11.5px;
  font-family: var(--sans);
  letter-spacing: 0.01em;
}
.attachment-details summary:hover { color: var(--accent); }
.attachment-dsl {
  background: var(--code-bg);
  color: var(--code-fg);
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-size: 11.5px;
  overflow-x: auto;
  margin: 8px 0;
  font-family: var(--mono);
  border: 1px solid var(--code-rule);
  line-height: 1.5;
  white-space: pre;
  tab-size: 2;
  font-variant-ligatures: none;
  font-feature-settings: 'liga' 0, 'calt' 0;
}
.attachment-preview-rows { font-size: 11px; }
.attachment-preview-rows table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.attachment-preview-rows th {
  text-align: left;
  background: var(--subtle);
  padding: 6px 8px;
  border-bottom: 1px solid var(--rule-strong);
  font-weight: 600;
  font-size: 10.5px;
  color: var(--ink-2);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.attachment-preview-rows td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
}
.preview-more {
  color: var(--muted);
  padding: 6px 8px;
  font-style: italic;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 14, 'SOFT' 50;
}
.attachment-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

.agent-summary-charts {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agent-summary-chart {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: 14px 16px 12px;
}
.asc-header { margin-bottom: 4px; }
.asc-title-block { display: flex; flex-direction: column; gap: 4px; }
.asc-title {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 17px;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--ink);
  margin: 0;
}
.asc-explanation {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 14, 'SOFT' 70;
  font-size: 13.5px;
  color: var(--ink-2);
  margin: 6px 0 10px;
}
.asc-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.referenced-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.ref-chip {
  background: rgba(250, 247, 242, 0.18);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 3px;
  color: var(--paper);
  font-family: var(--mono);
  letter-spacing: 0;
  border: 1px solid rgba(250, 247, 242, 0.15);
}

.input-area {
  flex-shrink: 0;
  border-top: 1px solid var(--rule);
  background: var(--paper);
}
.referenced-bar {
  display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  padding: 10px 18px;
  border-bottom: 1px solid var(--rule-soft);
  background: var(--subtle);
}
.referenced-label {
  color: var(--muted);
  font-weight: 500;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.ref-chip.removable {
  background: var(--accent-soft);
  color: var(--accent-deep);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 11.5px;
  font-family: var(--sans);
  border: 1px solid rgba(168, 65, 43, 0.15);
}
.ref-remove { cursor: pointer; font-size: 10px; opacity: 0.6; }
.ref-remove:hover { opacity: 1; }

.typing-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  animation: blink 1.1s infinite;
  margin-left: 4px;
}
@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }
</style>
