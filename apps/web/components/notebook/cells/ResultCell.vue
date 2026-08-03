<script setup lang="ts">
import { ref, computed, watch, h } from 'vue'
import {
  BarChartOutlined,
  TableOutlined,
  MessageOutlined,
  ReloadOutlined,
  UndoOutlined,
  CodeOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import ChartRenderer from '../ChartRenderer.vue'
import { inferChartConfig } from '~/composables/useChartInference'
import { useI18n } from '~/composables/useI18n'
import { formatDateValue, isDateLike, columnLooksLikeDates } from '~/composables/useDateFormat'
import type { ResultCell } from '~/types/notebook'

const { t } = useI18n()

interface Props {
  cell: ResultCell
  /** True while the parent is re-running this result's DSL. */
  refreshing?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  askAbout: []
  refresh: []
  /** Persist a new column display order on this cell's meta_json. */
  reorderColumns: [order: string[]]
  /** User edited the DSL — parent patches meta_json and persists. */
  updateDsl: [dsl: string]
  /** User wants the agent to help modify this query. Page handler references
   *  this cell + uncollapses chat so the user can type the tweak. */
  askToTweak: []
}>()

const storedDsl = computed(() => {
  const dsl = (props.cell.meta_json as any)?.dsl
  return typeof dsl === 'string' ? dsl : ''
})
const canRefresh = computed(() => storedDsl.value.trim().length > 0)

// --- Source / DSL panel state ---------------------------------------------
// Always available so users can see what's backing the result. Read-only
// fallback when no DSL is stored.

const showDsl = ref(false)
const dslDraft = ref('')
function toggleDsl() {
  showDsl.value = !showDsl.value
  if (showDsl.value) dslDraft.value = storedDsl.value
}
const dslDirty = computed(() => dslDraft.value !== storedDsl.value)
function saveDsl() {
  if (!dslDirty.value) return
  emit('updateDsl', dslDraft.value)
}
// Re-hydrate after upstream changes (e.g. refresh) when the panel is open
// and the user isn't actively editing.
watch(storedDsl, (next) => {
  if (showDsl.value && !dslDirty.value) dslDraft.value = next
})

const showChart = ref(false)
const meta = computed(() => props.cell.meta_json)
const rows = computed(() => meta.value?.rows ?? [])
const columns = computed(() => meta.value?.columns ?? [])
const chartConfig = computed(() => inferChartConfig(rows.value, columns.value))

/**
 * Effective display order: respect `meta.columnOrder` when set, drop any
 * entries that no longer exist (e.g. after a refresh that returned a
 * different schema), then append any new columns that aren't in the saved
 * order — so newly-arrived fields stay visible instead of being hidden.
 */
const orderedColumns = computed(() => {
  const savedOrder = meta.value?.columnOrder ?? []
  const actual = columns.value
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of savedOrder) {
    if (actual.includes(c) && !seen.has(c)) { out.push(c); seen.add(c) }
  }
  for (const c of actual) {
    if (!seen.has(c)) { out.push(c); seen.add(c) }
  }
  return out
})

const hasCustomOrder = computed(() =>
  (meta.value?.columnOrder?.length ?? 0) > 0
)

/**
 * Pick a comparator per column based on the first non-null sample value.
 *   - Numbers → numeric subtract.
 *   - Date-like (column name OR sample parses as a date) → compare as Date
 *     millis after `formatDateValue`'s parser pipeline.
 *   - Everything else → locale-aware string compare.
 * The same `isDateCol` flag drives the cell renderer below.
 */
function compareForColumn(c: string, sample: unknown, isDateCol: boolean) {
  if (isDateCol) {
    return (a: any, b: any) => {
      const da = new Date(a?.[c] as any).getTime()
      const db = new Date(b?.[c] as any).getTime()
      return (Number.isFinite(da) ? da : 0) - (Number.isFinite(db) ? db : 0)
    }
  }
  if (typeof sample === 'number') {
    return (a: any, b: any) => (Number(a?.[c]) || 0) - (Number(b?.[c]) || 0)
  }
  return (a: any, b: any) => String(a?.[c] ?? '').localeCompare(String(b?.[c] ?? ''))
}

// --- Column drag-reorder state --------------------------------------------
// Native HTML5 drag-and-drop on the table headers. AntD's `a-table` lets us
// inject attrs/handlers onto each <th> via `customHeaderCell`. We track:
//   • `dragKey` — which column the user is currently dragging
//   • `dropKey` — the column being hovered over (for the visual indicator)
//   • `dropEdge` — whether the drop will land left or right of `dropKey`
// On drop we splice `dragKey` to the new position and emit the new order.

const dragKey = ref<string | null>(null)
const dropKey = ref<string | null>(null)
const dropEdge = ref<'left' | 'right'>('right')

function onHeaderDragStart(col: string, ev: DragEvent) {
  dragKey.value = col
  // Use the column key as the payload so other drop targets (in theory) could
  // accept it. dataTransfer is mandatory on some browsers to start the drag.
  ev.dataTransfer?.setData('text/plain', col)
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
}
function onHeaderDragOver(col: string, ev: DragEvent) {
  if (!dragKey.value || dragKey.value === col) return
  ev.preventDefault()  // required to allow drop
  // Snap the drop edge based on cursor position within the target cell so the
  // user can pick "before" vs "after" precisely.
  const target = ev.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  dropEdge.value = ev.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
  dropKey.value = col
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
}
function onHeaderDragLeave(col: string) {
  // Only clear the indicator if we're leaving the currently-tracked target —
  // dragover on a neighboring th will overwrite it on its own.
  if (dropKey.value === col) dropKey.value = null
}
function onHeaderDrop(col: string, ev: DragEvent) {
  ev.preventDefault()
  const from = dragKey.value
  if (!from || from === col) { resetDragState(); return }
  const cur = [...orderedColumns.value]
  const fromIdx = cur.indexOf(from)
  if (fromIdx < 0) { resetDragState(); return }
  cur.splice(fromIdx, 1)
  let toIdx = cur.indexOf(col)
  if (toIdx < 0) { resetDragState(); return }
  if (dropEdge.value === 'right') toIdx += 1
  cur.splice(toIdx, 0, from)
  emit('reorderColumns', cur)
  resetDragState()
}
function onHeaderDragEnd() { resetDragState() }
function resetDragState() {
  dragKey.value = null
  dropKey.value = null
  dropEdge.value = 'right'
}

function resetOrder() {
  emit('reorderColumns', [])
}

const tableColumns = computed(() =>
  orderedColumns.value.map(c => {
    const sampleNonNull = rows.value.find(r => r[c] != null)?.[c]
    // `columnLooksLikeDates` is name-or-value: matches standard time column
    // names OR detects when ≥80% of sampled values parse as dates.
    const isDateCol = columnLooksLikeDates(rows.value, c)
    return {
      title: c,
      dataIndex: c,
      key: c,
      ellipsis: true,
      sorter: compareForColumn(c, sampleNonNull, isDateCol),
      customHeaderCell: () => ({
        draggable: true,
        class: [
          'th-draggable',
          dragKey.value === c ? 'th-dragging' : '',
          dropKey.value === c && dropEdge.value === 'left' ? 'th-drop-left' : '',
          dropKey.value === c && dropEdge.value === 'right' ? 'th-drop-right' : ''
        ].filter(Boolean).join(' '),
        onDragstart: (ev: DragEvent) => onHeaderDragStart(c, ev),
        onDragover:  (ev: DragEvent) => onHeaderDragOver(c, ev),
        onDragleave: () => onHeaderDragLeave(c),
        onDrop:      (ev: DragEvent) => onHeaderDrop(c, ev),
        onDragend:   () => onHeaderDragEnd()
      }),
      customRender: ({ text }: { text: unknown }) => {
        if (isDateCol) {
          const out = formatDateValue(text)
          if (out) return out
        }
        return text == null ? '' : String(text)
      }
    }
  })
)
</script>

<template>
  <div class="result-cell">
    <div v-if="meta.title" class="result-title-row">
      <h3 class="result-title">{{ meta.title }}</h3>
    </div>
    <div class="result-header">
      <div class="result-meta-group">
        <span class="eyebrow">{{ t('ui.result.eyebrow') }}</span>
        <span class="result-rule" />
        <span class="result-meta mono">{{ rows.length }} {{ rows.length === 1 ? t('ui.result.rows_one') : t('ui.result.rows_other') }} · {{ columns.length }} {{ columns.length === 1 ? t('ui.result.cols_one') : t('ui.result.cols_other') }}</span>
      </div>
      <div class="result-header-actions">
        <a-button-group v-if="chartConfig" size="small">
          <a-button :type="!showChart ? 'primary' : 'default'" @click="showChart = false" :icon="h(TableOutlined)">{{ t('ui.result.table') }}</a-button>
          <a-button :type="showChart ? 'primary' : 'default'" @click="showChart = true" :icon="h(BarChartOutlined)">{{ t('ui.result.chart') }}</a-button>
        </a-button-group>

        <!--
          Column reordering is now driven by dragging the table headers
          directly — no popover needed. A small Undo button surfaces only
          when there's a custom order saved, so the user can fall back to
          the schema order in one click.
        -->
        <a-tooltip v-if="hasCustomOrder && !showChart" :title="t('ui.result.reorderReset')">
          <a-button
            size="small"
            type="text"
            :icon="h(UndoOutlined)"
            @click="resetOrder"
          />
        </a-tooltip>

        <a-tooltip :title="showDsl ? t('ui.result.hideDsl') : t('ui.result.showDsl')">
          <a-button
            size="small"
            :type="showDsl ? 'primary' : 'text'"
            :icon="h(CodeOutlined)"
            @click="toggleDsl"
          />
        </a-tooltip>
        <a-tooltip v-if="canRefresh" :title="t('ui.result.refresh')">
          <a-button
            size="small"
            type="text"
            :icon="h(ReloadOutlined)"
            :loading="refreshing"
            @click="emit('refresh')"
          />
        </a-tooltip>
        <a-tooltip :title="t('ui.result.askAbout')">
          <a-button size="small" type="text" :icon="h(MessageOutlined)" @click="emit('askAbout')" />
        </a-tooltip>
      </div>
    </div>

    <!--
      Source / DSL panel. When a DSL is stored: editable textarea + Save.
      When not: a short note + "Ask agent to tweak" since there's nothing to
      edit directly. Save commits via `updateDsl` to the parent; the cell's
      existing Refresh button re-runs the saved DSL.
    -->
    <div v-if="showDsl" class="dsl-panel">
      <div class="dsl-panel-head">
        <span class="eyebrow">{{ t('ui.result.dslPanelTitle') }}</span>
        <a-button
          size="small"
          :icon="h(ThunderboltOutlined)"
          @click="emit('askToTweak')"
        >{{ t('ui.result.askTweak') }}</a-button>
      </div>

      <template v-if="storedDsl">
        <a-textarea
          v-model:value="dslDraft"
          :auto-size="{ minRows: 4, maxRows: 18 }"
          class="dsl-textarea"
          spellcheck="false"
        />
        <div class="dsl-actions">
          <a-button
            size="small"
            type="primary"
            :disabled="!dslDirty"
            @click="saveDsl"
          >{{ t('ui.result.saveDsl') }}</a-button>
          <span v-if="dslDirty" class="dsl-dirty">{{ t('ui.result.dslDirty') }}</span>
        </div>
        <div class="dsl-panel-foot">{{ t('ui.result.dslHint') }}</div>
      </template>
      <template v-else>
        <div class="dsl-empty-note">{{ t('ui.result.dslEmpty') }}</div>
      </template>
    </div>

    <ChartRenderer
      v-if="showChart && chartConfig"
      :type="chartConfig.type"
      :x-field="chartConfig.xField"
      :y-field="chartConfig.yField"
      :rows="rows"
      :title="chartConfig.title"
    />

    <a-table
      v-else
      :columns="tableColumns"
      :data-source="rows"
      :pagination="rows.length > 20 ? { pageSize: 20, size: 'small' } : false"
      size="small"
      :scroll="{ x: true }"
      row-key="__idx"
      :rowKey="(_: any, idx: number) => String(idx)"
    />
  </div>
</template>

<style scoped>
.result-cell {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  overflow: hidden;
}
.result-title-row {
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--rule-soft);
  background: var(--surface);
}
.result-title {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 17px;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--ink);
  margin: 0;
}
.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--subtle);
  border-bottom: 1px solid var(--rule);
}
.result-meta-group {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.result-rule {
  width: 1px;
  height: 12px;
  background: var(--rule-strong);
}
.result-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.result-meta {
  font-size: 12.5px;
  color: var(--ink-2);
  letter-spacing: 0.01em;
}
.result-cell :deep(.ant-table) { background: transparent; }
.result-cell :deep(.ant-table-tbody > tr > td) {
  font-family: var(--mono);
  font-size: 13.5px;
  letter-spacing: 0;
}
/* Draggable column headers — `customHeaderCell` adds `.th-draggable` to each
 * <th>. We use CSS for cursor + drop indicators because the drag handlers
 * live in script. Sort click still works since HTML5 drag is initiated by
 * mousedown + move, not by a plain click. */
.result-cell :deep(.ant-table-thead > tr > th.th-draggable) {
  cursor: grab;
  position: relative;
  user-select: none;
}
.result-cell :deep(.ant-table-thead > tr > th.th-draggable:active) {
  cursor: grabbing;
}
.result-cell :deep(.ant-table-thead > tr > th.th-dragging) {
  opacity: 0.45;
}
/* Drop indicator — a vertical accent bar on the leading edge of the target
 * cell. `left`/`right` variants are toggled by the cursor's horizontal
 * position within the cell so the user can pick "before" or "after". */
.result-cell :deep(.ant-table-thead > tr > th.th-drop-left)::before,
.result-cell :deep(.ant-table-thead > tr > th.th-drop-right)::after {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--accent);
  border-radius: 2px;
  pointer-events: none;
}
.result-cell :deep(.ant-table-thead > tr > th.th-drop-left)::before  { left: -2px; }
.result-cell :deep(.ant-table-thead > tr > th.th-drop-right)::after { right: -2px; }

.result-cell :deep(.ant-table-thead .ant-table-column-sorter) {
  color: var(--mute-low);
}
.result-cell :deep(.ant-table-thead .ant-table-column-sorter-up.active),
.result-cell :deep(.ant-table-thead .ant-table-column-sorter-down.active) {
  color: var(--accent);
}
.dsl-panel {
  background: var(--code-bg);
  border-bottom: 1px solid var(--code-rule);
  padding: 12px 14px;
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
.dsl-actions { display: flex; align-items: center; gap: 10px; }
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

.result-cell :deep(.ant-table-pagination) {
  padding: 10px 14px !important;
  margin: 0 !important;
  border-top: 1px solid var(--rule-soft);
}
</style>
