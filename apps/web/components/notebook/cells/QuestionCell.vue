<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, h } from 'vue'
import { marked } from 'marked'
import {
  ReloadOutlined,
  PlayCircleOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  TableOutlined,
  BarChartOutlined,
  CodeOutlined,
  CopyOutlined,
  MessageOutlined,
  QuestionCircleOutlined
} from '@ant-design/icons-vue'
import ChartRenderer from '../ChartRenderer.vue'
import { inferChartConfig } from '~/composables/useChartInference'
import { useI18n } from '~/composables/useI18n'
import { formatDateValue, columnLooksLikeDates } from '~/composables/useDateFormat'
import type { QuestionCell, ChatSummaryChart } from '~/types/notebook'

const { t } = useI18n()

interface Props {
  cell: QuestionCell
  /** True while the parent is re-running this question against the agent. */
  running?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  /** Persist an edited question prompt. */
  save: [question: string]
  /** Re-run the question against the agent. */
  run: []
  /** Reference this question + its data in the chat sidebar. */
  askAbout: []
}>()

const meta = computed(() => props.cell.meta_json ?? {})
const answer = computed(() => meta.value.answer ?? '')
const aggregations = computed(() => meta.value.aggregations ?? [])
const summaryCharts = computed(() => meta.value.summaryCharts ?? [])
const lastError = computed(() => meta.value.lastError ?? null)
const lastRunAt = computed(() => meta.value.lastRunAt ?? null)
const hasResult = computed(() =>
  !!answer.value.trim() || aggregations.value.length > 0 || summaryCharts.value.length > 0
)

// --- Question editing -------------------------------------------------------
const editing = ref(false)
const draft = ref(props.cell.content)
/** True while an IME conversion is open (Japanese/Chinese/Korean input). */
const composing = ref(false)
// If the cell arrives empty (just added), drop straight into edit mode so the
// user can type the question without an extra click.
if (!props.cell.content.trim()) editing.value = true

watch(() => props.cell.content, (next) => {
  if (!editing.value) draft.value = next
})

function startEdit() {
  draft.value = props.cell.content
  editing.value = true
}
function cancelEdit() {
  draft.value = props.cell.content
  editing.value = false
}
function saveEdit() {
  const next = draft.value.trim()
  editing.value = false
  if (next && next !== props.cell.content) emit('save', next)
}
// Cmd/Ctrl+Enter saves and runs in one step.
function onEditorKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    // An open IME conversion owns this keystroke — `draft` is still the
    // pre-conversion value until `compositionend`, so acting now would save
    // the wrong text. See the same guard in AgentInputBar.
    if (composing.value || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    const next = draft.value.trim()
    if (!next) return
    editing.value = false
    if (next !== props.cell.content) emit('save', next)
    emit('run')
  }
}

function renderMarkdown(content: string): string {
  if (!content.trim()) return ''
  return marked.parse(content) as string
}

function aggLabel(agg: { explanation?: string }, idx: number): string {
  return agg.explanation?.trim() || t('ui.question.resultLabel', { n: idx + 1 })
}

// Per-aggregation table/chart toggle. Keyed by index; defaults to table.
const chartView = ref<Record<number, boolean>>({})
function aggChartConfig(agg: { rows: Record<string, unknown>[]; columns: string[] }) {
  return inferChartConfig(agg.rows, agg.columns)
}

/** Same date handling as ResultCell's table: epoch-ish columns (by name or
 *  by sampled values) render as short human dates instead of raw millis. */
function aggTableColumns(agg: { rows: Record<string, unknown>[]; columns: string[] }) {
  return agg.columns.map(c => {
    const isDateCol = columnLooksLikeDates(agg.rows, c)
    return {
      title: c,
      dataIndex: c,
      key: c,
      ellipsis: true,
      customRender: ({ text }: { text: unknown }) => {
        if (isDateCol) {
          const out = formatDateValue(text)
          if (out) return out
        }
        return text == null ? '' : String(text)
      }
    }
  })
}

/**
 * Per-aggregation aggDSL panel. Read-only: unlike a result cell — whose DSL is
 * the cell's own definition and so is editable — a question's queries are
 * derived from the question text, and a re-run regenerates them the moment that
 * text changes. Showing them explains *how* the answer was reached and gives
 * something to copy into a query cell; it isn't an edit surface.
 */
const dslView = ref<Record<number, boolean>>({})
function aggDsl(agg: { dsl?: string }): string {
  return typeof agg.dsl === 'string' ? agg.dsl.trim() : ''
}

const copiedIdx = ref<number | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
async function copyDsl(idx: number, dsl: string) {
  try {
    await navigator.clipboard.writeText(dsl)
    copiedIdx.value = idx
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedIdx.value = null }, 1500)
  } catch {
    // Clipboard blocked (insecure origin / denied permission) — the DSL is
    // already on screen and selectable, so there's nothing to fall back to.
  }
}
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer) })

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

// Per-summary-chart source table toggle. Keyed by index; defaults to chart.
const summarySourceView = ref<Record<number, boolean>>({})

function summarySourceTable(spec: ChatSummaryChart): { columns: string[]; rows: Record<string, unknown>[] } {
  const labelSet = new Set<string>()
  for (const s of spec.series) for (const p of s.points) labelSet.add(p.label)
  const labels = Array.from(labelSet)
  const columns = ['label', ...spec.series.map(s => s.name)]
  const rows = labels.map(label => {
    const row: Record<string, unknown> = { label }
    for (const s of spec.series) {
      row[s.name] = s.points.find(p => p.label === label)?.value ?? null
    }
    return row
  })
  return { columns, rows }
}

const runLabel = computed(() => (hasResult.value ? t('ui.question.rerun') : t('ui.question.run')))
// Once the first run has captured DSLs, re-run replays those exact queries and
// only reinterprets — call that out so the cost/behaviour is predictable.
const hasStoredDsls = computed(() =>
  aggregations.value.some(a => typeof (a as any)?.dsl === 'string' && (a as any).dsl.trim())
)
const runTooltip = computed(() =>
  hasStoredDsls.value ? t('ui.question.rerunTooltip') : t('ui.question.runTooltip')
)
</script>

<template>
  <div class="question-cell" :class="{ 'is-running': running }">
    <!-- Prompt row -->
    <div class="q-head">
      <span class="q-mark"><component :is="h(QuestionCircleOutlined)" /></span>

      <div class="q-prompt">
        <template v-if="editing">
          <a-textarea
            v-model:value="draft"
            :auto-size="{ minRows: 1, maxRows: 8 }"
            :placeholder="t('ui.question.placeholder')"
            class="q-editor"
            spellcheck="false"
            autofocus
            @keydown="onEditorKeydown"
            @compositionstart="composing = true"
            @compositionend="composing = false"
          />
          <div class="q-editor-actions">
            <a-button size="small" type="primary" :icon="h(CheckOutlined)" @click="saveEdit">
              {{ t('ui.question.saveQuestion') }}
            </a-button>
            <a-button size="small" type="text" :icon="h(CloseOutlined)" @click="cancelEdit">
              {{ t('ui.question.cancel') }}
            </a-button>
            <span class="q-editor-hint">{{ t('ui.question.editorHint') }}</span>
          </div>
        </template>
        <template v-else>
          <p class="q-text" @click="startEdit">{{ cell.content || t('ui.question.placeholder') }}</p>
        </template>
      </div>

      <div class="q-actions">
        <a-tooltip :title="runTooltip">
          <a-button
            size="small"
            type="primary"
            :icon="h(hasResult ? ReloadOutlined : PlayCircleOutlined)"
            :loading="running"
            :disabled="!cell.content.trim()"
            @click="emit('run')"
          >{{ runLabel }}</a-button>
        </a-tooltip>
        <a-tooltip v-if="!editing" :title="t('ui.question.edit')">
          <a-button size="small" type="text" :icon="h(EditOutlined)" @click="startEdit" />
        </a-tooltip>
        <a-tooltip :title="t('ui.question.askAbout')">
          <a-button size="small" type="text" :icon="h(MessageOutlined)" @click="emit('askAbout')" />
        </a-tooltip>
      </div>
    </div>

    <!-- Output -->
    <div v-if="lastError" class="q-error">{{ lastError }}</div>

    <div v-if="hasResult || running" class="q-output">
      <a-spin v-if="running && !hasResult" class="q-spin" />

      <div v-if="answer" class="q-answer" v-html="renderMarkdown(answer)" />

      <!-- Aggregations (possibly several sources combined into one answer) -->
      <div
        v-for="(agg, idx) in aggregations"
        :key="`agg-${idx}`"
        class="q-agg"
      >
        <div class="q-agg-head">
          <span class="q-agg-label">{{ aggLabel(agg, idx) }}</span>
          <div class="q-agg-head-right">
            <span class="q-agg-meta mono">{{ t('ui.question.rowsLabel', { n: agg.rows.length }) }}</span>
            <a-button-group v-if="aggChartConfig(agg)" size="small">
              <a-button
                :type="!chartView[idx] ? 'primary' : 'default'"
                :icon="h(TableOutlined)"
                @click="chartView[idx] = false"
              >{{ t('ui.question.table') }}</a-button>
              <a-button
                :type="chartView[idx] ? 'primary' : 'default'"
                :icon="h(BarChartOutlined)"
                @click="chartView[idx] = true"
              >{{ t('ui.question.chart') }}</a-button>
            </a-button-group>
            <a-tooltip
              v-if="aggDsl(agg)"
              :title="dslView[idx] ? t('ui.question.hideDsl') : t('ui.question.showDsl')"
            >
              <a-button
                size="small"
                :type="dslView[idx] ? 'primary' : 'text'"
                :icon="h(CodeOutlined)"
                @click="dslView[idx] = !dslView[idx]"
              />
            </a-tooltip>
          </div>
        </div>

        <!-- The aggDSL this result came from. Re-run replays it verbatim. -->
        <div v-if="dslView[idx] && aggDsl(agg)" class="q-agg-dsl-panel">
          <div class="q-agg-dsl-head">
            <span class="eyebrow">{{ t('ui.question.dslPanelTitle') }}</span>
            <a-button
              size="small"
              :icon="h(CopyOutlined)"
              @click="copyDsl(idx, aggDsl(agg))"
            >{{ copiedIdx === idx ? t('ui.question.dslCopied') : t('ui.question.copyDsl') }}</a-button>
          </div>
          <pre class="q-agg-dsl">{{ aggDsl(agg) }}</pre>
          <div class="q-agg-dsl-foot">{{ t('ui.question.dslHint') }}</div>
        </div>

        <ChartRenderer
          v-if="chartView[idx] && aggChartConfig(agg)"
          :type="aggChartConfig(agg)!.type"
          :x-field="aggChartConfig(agg)!.xField"
          :y-field="aggChartConfig(agg)!.yField"
          :rows="agg.rows"
          :title="''"
        />
        <a-table
          v-else
          :columns="aggTableColumns(agg)"
          :data-source="agg.rows"
          :pagination="agg.rows.length > 20 ? { pageSize: 20, size: 'small' } : false"
          size="small"
          :scroll="{ x: true }"
          :rowKey="(_: any, i: number) => String(i)"
        />
      </div>

      <!-- Agent-built summary charts -->
      <div
        v-for="(chart, idx) in summaryCharts"
        :key="`sc-${idx}`"
        class="q-summary-chart"
      >
        <div class="q-sc-head">
          <div>
            <h4 class="q-sc-title">{{ chart.title }}</h4>
            <p v-if="chart.explanation" class="q-sc-explanation">{{ chart.explanation }}</p>
          </div>
          <a-button
            size="small"
            type="text"
            :icon="h(TableOutlined)"
            @click="summarySourceView[idx] = !summarySourceView[idx]"
          >{{ summarySourceView[idx] ? t('ui.question.hideSource') : t('ui.question.showSource') }}</a-button>
        </div>
        <template v-if="summarySourceView[idx]">
          <a-table
            :columns="summarySourceTable(chart).columns.map(c => ({ title: c, dataIndex: c, key: c, ellipsis: true }))"
            :data-source="summarySourceTable(chart).rows"
            :pagination="summarySourceTable(chart).rows.length > 20 ? { pageSize: 20, size: 'small' } : false"
            size="small"
            :scroll="{ x: true }"
            :rowKey="(_: any, i: number) => String(i)"
          />
        </template>
        <ChartRenderer v-else :type="chart.chartType" v-bind="summaryToRenderer(chart)" :title="''" />
      </div>
    </div>

    <div v-if="lastRunAt && !running" class="q-foot mono">
      {{ t('ui.question.lastRun') }} {{ new Date(lastRunAt).toLocaleString() }}
    </div>
  </div>
</template>

<style scoped>
.question-cell {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-md);
  overflow: hidden;
}
.q-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: var(--subtle);
  border-bottom: 1px solid var(--rule-soft);
}
.q-mark {
  color: var(--accent);
  font-size: 16px;
  margin-top: 2px;
  flex-shrink: 0;
}
.q-prompt { flex: 1; min-width: 0; }
.q-text {
  margin: 0;
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 16px;
  line-height: 1.35;
  letter-spacing: -0.005em;
  color: var(--ink);
  cursor: text;
  white-space: pre-wrap;
}
.q-editor :deep(.ant-input) {
  font-family: var(--serif) !important;
  font-size: 16px !important;
  line-height: 1.35 !important;
  color: var(--ink) !important;
  background: var(--surface) !important;
  border: 1px solid var(--rule) !important;
  border-radius: var(--r-sm) !important;
}
.q-editor :deep(.ant-input:focus) {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(168, 65, 43, 0.15) !important;
}
.q-editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.q-editor-hint {
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
  font-family: var(--sans);
}
.q-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.q-error {
  padding: 10px 14px;
  background: rgba(168, 65, 43, 0.08);
  color: var(--accent-deep, #8a3422);
  font-size: 13px;
  font-family: var(--mono);
  border-bottom: 1px solid var(--rule-soft);
}
.q-output { padding: 14px; display: flex; flex-direction: column; gap: 16px; }
.q-spin { align-self: center; padding: 12px; }
.q-answer {
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--ink);
  font-family: var(--sans);
}
.q-answer :deep(p) { margin: 0.35em 0; }
.q-answer :deep(strong) { font-weight: 600; }
.q-answer :deep(ul), .q-answer :deep(ol) { padding-left: 20px; margin: 0.4em 0; }
.q-answer :deep(code) {
  background: var(--subtle-2);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 13px;
  font-family: var(--mono);
}
.q-agg {
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.q-agg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--subtle);
  border-bottom: 1px solid var(--rule);
}
.q-agg-head-right { display: flex; align-items: center; gap: 10px; }
.q-agg-label {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 18, 'SOFT' 50;
  font-size: 13.5px;
  color: var(--ink);
}
.q-agg-meta { font-size: 10.5px; color: var(--muted); letter-spacing: 0.02em; }
.q-agg :deep(.ant-table-tbody > tr > td) {
  font-family: var(--mono);
  font-size: 12.5px;
}
.q-agg-dsl-panel {
  background: var(--code-bg);
  border-bottom: 1px solid var(--code-rule);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-agg-dsl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.q-agg-dsl-head .eyebrow { color: var(--code-muted); }
.q-agg-dsl-head :deep(.ant-btn) {
  background: transparent;
  border: 1px solid var(--code-rule);
  color: var(--code-fg);
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.q-agg-dsl-head :deep(.ant-btn:hover) {
  background: rgba(168, 65, 43, 0.18) !important;
  border-color: var(--accent) !important;
  color: var(--code-fg) !important;
}
.q-agg-dsl {
  margin: 0;
  padding: 10px 12px;
  background: var(--code-bg-2);
  color: var(--code-fg);
  border: 1px solid var(--code-rule);
  border-radius: var(--r-sm);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre;
  overflow: auto;
  max-height: 320px;
  tab-size: 2;
  font-variant-ligatures: none;
  font-feature-settings: 'liga' 0, 'calt' 0;
}
.q-agg-dsl-foot {
  font-size: 11px;
  color: var(--code-muted);
  font-style: italic;
  font-family: var(--sans);
}
.q-summary-chart {
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  padding: 12px 14px;
}
.q-sc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.q-sc-title {
  margin: 0 0 4px;
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 22, 'SOFT' 40;
  font-size: 15px;
  color: var(--ink);
}
.q-sc-explanation {
  font-family: var(--serif);
  font-style: italic;
  font-size: 13px;
  color: var(--ink-2);
  margin: 0;
}
.q-foot {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--rule-soft);
}
</style>
