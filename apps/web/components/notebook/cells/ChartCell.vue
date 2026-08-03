<script setup lang="ts">
import { ref, computed, watch, h } from 'vue'
import {
  MessageOutlined,
  LineChartOutlined,
  BarChartOutlined,
  PieChartOutlined,
  ReloadOutlined,
  CodeOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import ChartRenderer from '../ChartRenderer.vue'
import { useI18n } from '~/composables/useI18n'
import type { ChartCell, ChartType } from '~/types/notebook'

const { t } = useI18n()

interface Props {
  cell: ChartCell
  /** True while the parent is re-running this chart's DSL(s). Disables the
   *  refresh button and shows a spinner so the user can see work in flight. */
  refreshing?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  askAbout: []
  changeType: [type: ChartType]
  refresh: []
  /**
   * User edited the DSL for a series. `seriesIndex === null` means the
   * single-series legacy path (cell-level `meta.dsl`); a number indexes into
   * `meta.series[]`. The parent patches meta_json and persists.
   */
  updateDsl: [seriesIndex: number | null, dsl: string]
  /**
   * User wants the agent to help modify this chart. Page handler should
   * reference this cell + uncollapse chat so the user can type the tweak.
   */
  askToTweak: []
}>()

const meta = computed(() => props.cell.meta_json)
const currentType = computed<ChartType>(() => (meta.value.chartType as ChartType) || 'bar')

const seriesList = computed(() => meta.value.series ?? [])
const isMulti = computed(() => seriesList.value.length > 0)
const singleDsl = computed(() => meta.value.dsl ?? '')

// Refresh is offered when at least one DSL is known — without DSL there's
// nothing to re-run.
const canRefresh = computed(() => {
  if (singleDsl.value.trim()) return true
  return seriesList.value.some(s => s.dsl?.trim())
})
// The DSL/source toggle is ALWAYS available so users can see what's backing
// a chart and ask the agent to tweak it. When no DSL is stored (agent-built
// `build_summary_chart` charts have only pre-computed `{label, value}`
// points) the panel falls back to a read-only points view and emphasizes
// "Ask agent to tweak" instead of an editor.
const canShowDsl = computed(() => true)
const hasAnyDsl = canRefresh

// --- DSL editor state ------------------------------------------------------
// `drafts` is keyed by series index ("single" for the legacy single-series
// path). Initialized lazily when the panel opens so we don't shadow upstream
// changes until the user actively edits.

const showDsl = ref(false)
const drafts = ref<Record<string, string>>({})

function toggleDsl() {
  showDsl.value = !showDsl.value
  if (showDsl.value) hydrateDrafts()
}

function hydrateDrafts() {
  const next: Record<string, string> = {}
  if (isMulti.value) {
    seriesList.value.forEach((s, i) => { next[String(i)] = s.dsl ?? '' })
  } else {
    next['single'] = singleDsl.value
  }
  drafts.value = next
}

// Re-hydrate when the upstream cell rows change (e.g. after a refresh) and
// the user isn't actively editing. We diff by JSON because Vue's deep watch
// on meta would fire on every renderer-driven prop change.
watch(
  () => [singleDsl.value, JSON.stringify(seriesList.value.map(s => s.dsl ?? ''))],
  () => { if (showDsl.value) hydrateDrafts() }
)

function dirtyFor(key: string, original: string): boolean {
  return (drafts.value[key] ?? '') !== original
}

function saveSingle() {
  const next = drafts.value['single'] ?? ''
  if (next.trim() === singleDsl.value.trim()) return
  emit('updateDsl', null, next)
}
function saveSeries(idx: number) {
  const next = drafts.value[String(idx)] ?? ''
  const cur = seriesList.value[idx]?.dsl ?? ''
  if (next.trim() === cur.trim()) return
  emit('updateDsl', idx, next)
}

// --- Chart type switch -----------------------------------------------------

const typeOptions: { value: ChartType; icon: any; label: string }[] = [
  { value: 'bar',   icon: BarChartOutlined,  label: 'Bar' },
  { value: 'line',  icon: LineChartOutlined, label: 'Line' },
  { value: 'donut', icon: PieChartOutlined,  label: 'Donut' }
]

function selectType(type: ChartType) {
  if (type === currentType.value) return
  emit('changeType', type)
}

/**
 * Render the agent's pre-computed `{ label, value }` (or arbitrary row)
 * points as an aligned two-column preview. Read-only — the agent owns this
 * data, so editing has to go through "Ask agent to tweak".
 */
function formatRowsForPreview(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '(no points)'
  const keys = Object.keys(rows[0])
  const lines: string[] = []
  const labelKey = keys.includes('label') ? 'label' : keys[0]
  const valueKey = keys.includes('value') ? 'value' : (keys[1] ?? keys[0])
  const labelPad = Math.min(28, Math.max(...rows.map(r => String(r[labelKey] ?? '').length)))
  for (const r of rows.slice(0, 60)) {
    const lab = String(r[labelKey] ?? '').padEnd(labelPad)
    const val = r[valueKey]
    lines.push(`${lab}  ${val}`)
  }
  if (rows.length > 60) lines.push(`… (${rows.length - 60} more)`)
  return lines.join('\n')
}
</script>

<template>
  <div class="chart-cell">
    <div class="chart-header">
      <div class="chart-title-block">
        <span class="eyebrow">{{ t('ui.chart.eyebrow') }}</span>
        <h3 v-if="meta.title" class="chart-title">{{ meta.title }}</h3>
      </div>
      <div class="chart-header-actions">
        <div class="chart-type-switch" role="tablist">
          <a-tooltip
            v-for="opt in typeOptions"
            :key="opt.value"
            :title="opt.label"
          >
            <button
              role="tab"
              :aria-selected="currentType === opt.value"
              :class="['type-btn', { 'type-btn--active': currentType === opt.value }]"
              @click="selectType(opt.value)"
            >
              <component :is="h(opt.icon)" />
            </button>
          </a-tooltip>
        </div>
        <a-tooltip v-if="canShowDsl" :title="showDsl ? t('ui.chart.hideDsl') : t('ui.chart.showDsl')">
          <a-button
            size="small"
            :type="showDsl ? 'primary' : 'text'"
            :icon="h(CodeOutlined)"
            @click="toggleDsl"
          />
        </a-tooltip>
        <a-tooltip v-if="canRefresh" :title="t('ui.chart.refresh')">
          <a-button
            size="small"
            type="text"
            :icon="h(ReloadOutlined)"
            :loading="refreshing"
            @click="emit('refresh')"
          />
        </a-tooltip>
        <a-tooltip :title="t('ui.chart.askAbout')">
          <a-button size="small" type="text" :icon="h(MessageOutlined)" @click="emit('askAbout')" />
        </a-tooltip>
      </div>
    </div>

    <!--
      Source panel — collapsed by default. Three rendering modes:
        1. No DSL stored at all (agent-built `build_summary_chart`): show the
           pre-computed points as a read-only data view, with a prominent
           "Ask agent to tweak" since there's nothing to edit directly.
        2. Single-series chart with `meta.dsl`: one editable textarea.
        3. Multi-series chart: per-series editors; series without DSL appear
           with a note explaining they can't be re-run individually.
      Saves go through `updateDsl` to the parent; the chart's Refresh button
      re-runs the saved DSL afterwards.
    -->
    <div v-if="showDsl" class="dsl-panel">
      <div class="dsl-panel-head">
        <span class="eyebrow">{{ t('ui.chart.dslPanelTitle') }}</span>
        <a-button
          size="small"
          :icon="h(ThunderboltOutlined)"
          @click="emit('askToTweak')"
        >{{ t('ui.chart.askTweak') }}</a-button>
      </div>

      <!-- Case 1: no DSL anywhere. Show points data + agent CTA. -->
      <template v-if="!hasAnyDsl">
        <div class="dsl-empty-note">
          {{ t('ui.chart.dslAgentBuilt') }}
        </div>
        <div
          v-for="(series, idx) in seriesList"
          :key="`points-${idx}`"
          class="dsl-block dsl-readonly"
        >
          <div class="dsl-series-head">
            <span class="dsl-series-name">{{ series.name }}</span>
            <span class="dsl-series-note">{{ (series.rows ?? []).length }} pts</span>
          </div>
          <pre class="points-pre">{{ formatRowsForPreview(series.rows ?? []) }}</pre>
        </div>
        <div v-if="seriesList.length === 0 && (meta.rows ?? []).length" class="dsl-block dsl-readonly">
          <pre class="points-pre">{{ formatRowsForPreview(meta.rows as Record<string, unknown>[]) }}</pre>
        </div>
      </template>

      <!-- Case 2: single-series legacy with DSL. -->
      <template v-else-if="!isMulti">
        <div class="dsl-block">
          <a-textarea
            v-model:value="drafts['single']"
            :auto-size="{ minRows: 4, maxRows: 18 }"
            class="dsl-textarea"
            spellcheck="false"
          />
          <div class="dsl-actions">
            <a-button
              size="small"
              type="primary"
              :disabled="!dirtyFor('single', singleDsl)"
              @click="saveSingle"
            >{{ t('ui.chart.saveDsl') }}</a-button>
            <span v-if="dirtyFor('single', singleDsl)" class="dsl-dirty">{{ t('ui.chart.dslDirty') }}</span>
          </div>
        </div>
      </template>

      <!-- Case 3: multi-series — one editor per series. -->
      <template v-else>
        <div
          v-for="(series, idx) in seriesList"
          :key="idx"
          class="dsl-block"
        >
          <div class="dsl-series-head">
            <span class="dsl-series-name">{{ series.name }}</span>
            <span v-if="!series.dsl" class="dsl-series-note">
              {{ t('ui.chart.dslNoneForSeries') }}
            </span>
          </div>
          <a-textarea
            v-if="series.dsl != null"
            v-model:value="drafts[String(idx)]"
            :auto-size="{ minRows: 4, maxRows: 14 }"
            class="dsl-textarea"
            spellcheck="false"
          />
          <div v-if="series.dsl != null" class="dsl-actions">
            <a-button
              size="small"
              type="primary"
              :disabled="!dirtyFor(String(idx), series.dsl ?? '')"
              @click="saveSeries(idx)"
            >{{ t('ui.chart.saveDsl') }}</a-button>
            <span v-if="dirtyFor(String(idx), series.dsl ?? '')" class="dsl-dirty">{{ t('ui.chart.dslDirty') }}</span>
          </div>
        </div>
      </template>

      <div class="dsl-panel-foot">{{ hasAnyDsl ? t('ui.chart.dslHint') : t('ui.chart.dslAgentHint') }}</div>
    </div>

    <ChartRenderer
      :type="currentType"
      :x-field="meta.xField"
      :y-field="meta.yField"
      :rows="(meta.rows ?? []) as Record<string, unknown>[]"
      :series="meta.series"
      :title="''"
    />
  </div>
</template>

<style scoped>
.chart-cell {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: 16px 18px 18px;
}
.chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
}
.chart-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.chart-title {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 19px;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--ink);
  margin: 0;
}

.chart-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chart-type-switch {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--paper);
}
.type-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
  border-right: 1px solid var(--rule);
}
.type-btn:last-child { border-right: none; }
.type-btn:hover { background: var(--subtle); color: var(--ink); }
.type-btn--active {
  background: var(--ink);
  color: var(--paper);
}
.type-btn--active:hover { background: var(--ink); color: var(--paper); }

/* DSL panel */
.dsl-panel {
  background: var(--code-bg);
  border: 1px solid var(--code-rule);
  border-radius: var(--r-md);
  padding: 10px 12px;
  margin-bottom: 14px;
  color: var(--code-fg);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsl-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dsl-panel-head .eyebrow { color: var(--code-muted); }
.dsl-panel-head :deep(.ant-btn) {
  background: transparent;
  border: 1px solid var(--code-rule);
  color: var(--code-fg);
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.dsl-panel-head :deep(.ant-btn:hover) {
  background: rgba(168, 65, 43, 0.18) !important;
  border-color: var(--accent) !important;
  color: var(--code-fg) !important;
}

.dsl-block { display: flex; flex-direction: column; gap: 6px; }

.dsl-series-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 4px 0 0;
}
.dsl-series-name {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 18, 'SOFT' 50;
  font-size: 13.5px;
  color: var(--code-fg);
}
.dsl-series-note {
  font-family: var(--sans);
  font-style: italic;
  font-size: 11.5px;
  color: var(--code-muted);
}

.dsl-textarea :deep(.ant-input) {
  font-family: var(--mono) !important;
  font-size: 12.5px !important;
  line-height: 1.55 !important;
  background: var(--code-bg-2) !important;
  color: var(--code-fg) !important;
  border: 1px solid var(--code-rule) !important;
  border-radius: var(--r-sm) !important;
  padding: 10px 12px !important;
}
.dsl-textarea :deep(.ant-input:focus) {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(168, 65, 43, 0.18) !important;
}

.dsl-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsl-actions :deep(.ant-btn-primary) {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.dsl-actions :deep(.ant-btn-primary:hover:not(:disabled)) {
  background: var(--accent-deep) !important;
  border-color: var(--accent-deep) !important;
}
.dsl-actions :deep(.ant-btn-primary:disabled) {
  background: var(--code-bg-2);
  border-color: var(--code-rule);
  color: var(--code-muted);
}
.dsl-dirty {
  font-size: 11px;
  color: #F4B0A2;
  font-family: var(--sans);
  font-style: italic;
}
.dsl-panel-foot {
  font-size: 11px;
  color: var(--code-muted);
  font-style: italic;
  font-family: var(--sans);
  padding-top: 2px;
}

.dsl-empty-note {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 18, 'SOFT' 70;
  font-size: 13.5px;
  color: var(--code-fg);
  background: var(--code-bg-2);
  border: 1px solid var(--code-rule);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  line-height: 1.5;
}
.dsl-readonly { gap: 4px; }
.points-pre {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
  background: var(--code-bg-2);
  color: var(--code-fg);
  border: 1px solid var(--code-rule);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  margin: 0;
  white-space: pre;
  overflow-x: auto;
  max-height: 220px;
  overflow-y: auto;
}
</style>
