<script setup lang="ts">
import { ref, computed, h, watch } from 'vue'
import { SearchOutlined, CloseCircleOutlined } from '@ant-design/icons-vue'
import { useI18n } from '~/composables/useI18n'
import { ONTOLOGY_KINDS, kindColor } from '~/composables/useOntologyKinds'
import type { ConceptMetric, OntologyConcept, OntologyEdge, OverlayWindow } from '~/types/ontology'

const { t } = useI18n()

interface GraphNode {
  id: string
  kind: string
  name: string
  url?: string
  description?: string
}

const props = defineProps<{
  /** The FULL node set — the list is never subject to the map's lens; finding
   *  a thing is exactly what you come here for. */
  nodes: GraphNode[]
  edges: OntologyEdge[]
  concepts: OntologyConcept[]
  metrics?: Record<string, { events: number; visitors: number }>
  conceptMetrics?: Record<string, ConceptMetric>
  selectedId?: string | null
  /** Window the usage column covers — shown so the numbers can't be read as
   *  a default 30 days when a shorter range is applied. */
  usageWindow?: OverlayWindow | null
}>()
const emit = defineEmits<{ select: [nodeId: string] }>()

const query = ref('')
/** Empty = no kind restriction. Chosen over "all selected" so the filter reads
 *  as off rather than as five active constraints. */
const kinds = ref<string[]>([])

const kindOptions = computed(() =>
  ONTOLOGY_KINDS.map(k => ({ label: t(`ui.ontology.legend.${k}`), value: k as string }))
)

/** feature/page id → the product area it belongs to. */
const areaOf = computed(() => {
  const byId = new Map(props.nodes.map(n => [n.id, n]))
  const out = new Map<string, string>()
  for (const e of props.edges) {
    if (e.type !== 'belongs_to') continue
    const area = byId.get(e.to)
    if (area) out.set(e.from, area.name)
  }
  return out
})

/** entity id → names of the concepts measuring it. */
const conceptsMeasuring = computed(() => {
  const out = new Map<string, string[]>()
  for (const c of props.concepts) {
    for (const m of c.measures) {
      if (!out.has(m)) out.set(m, [])
      out.get(m)!.push(c.name)
    }
  }
  return out
})

const nameById = computed(() => new Map(props.nodes.map(n => [n.id, n.name])))

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

interface Row {
  id: string
  kind: string
  name: string
  kindLabel: string
  /** Secondary line: owning area, measured entities, or url. */
  context: string
  events: number | null
  visitors: number | null
  kpi: ConceptMetric | null
  /** Everything the search box matches against, pre-lowercased. */
  haystack: string
}

const allRows = computed<Row[]>(() =>
  props.nodes.map(n => {
    const concept = n.kind === 'concept' ? props.concepts.find(c => c.id === n.id) ?? null : null
    const usage = props.metrics?.[n.id]
    const kpiRaw = concept ? props.conceptMetrics?.[concept.id] ?? null : null
    const context = concept
      ? concept.measures.map(m => nameById.value.get(m) ?? m).join(', ')
      : areaOf.value.get(n.id) ?? n.url ?? n.description ?? ''
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      kindLabel: t(`ui.ontology.legend.${n.kind}`),
      context,
      events: usage?.events ?? null,
      visitors: usage?.visitors ?? null,
      // An errored KPI is not a KPI — show a blank cell, the panel explains why.
      kpi: kpiRaw && !kpiRaw.error ? kpiRaw : null,
      haystack: `${n.name}\n${context}\n${concept?.definition ?? ''}`.toLowerCase()
    }
  })
)

const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  const kindSet = kinds.value.length ? new Set(kinds.value) : null
  return allRows.value.filter(r => {
    if (kindSet && !kindSet.has(r.kind)) return false
    if (!q) return true
    return r.haystack.includes(q)
  })
})

const filtered = computed(() => rows.value.length !== allRows.value.length)
function clearFilters() {
  query.value = ''
  kinds.value = []
}

// Concepts first, then areas, features, pages, track events, segments — matching the legend
// order — and alphabetical inside each group. Sorting by usage is one click away.
const KIND_RANK: Record<string, number> = { concept: 0, productArea: 1, feature: 2, page: 3, trackEvent: 4, segment: 5 }

const columns = computed(() => [
  {
    title: t('ui.ontology.listName'),
    dataIndex: 'name',
    key: 'name',
    sorter: (a: Row, b: Row) =>
      (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.name.localeCompare(b.name),
    defaultSortOrder: 'ascend' as const
  },
  { title: t('ui.ontology.listType'), dataIndex: 'kindLabel', key: 'kind', width: 130 },
  {
    title: t('ui.ontology.listUsage'),
    dataIndex: 'events',
    key: 'events',
    width: 150,
    align: 'right' as const,
    sorter: (a: Row, b: Row) => (a.events ?? -1) - (b.events ?? -1)
  },
  { title: t('ui.ontology.listKpi'), dataIndex: 'kpi', key: 'kpi', width: 130, align: 'right' as const }
])

// Reset to the first page whenever the filter changes, or a narrow result set
// can land on a page that no longer exists and look empty.
const page = ref(1)
watch([query, kinds], () => { page.value = 1 })

function rowProps(record: Row) {
  return {
    onClick: () => emit('select', record.id),
    class: record.id === props.selectedId ? 'ol-row is-selected' : 'ol-row'
  }
}
</script>

<template>
  <div class="ontology-list">
    <div class="ol-filters">
      <a-input
        v-model:value="query"
        :placeholder="t('ui.ontology.listSearchPh')"
        allow-clear
        class="ol-search"
      >
        <template #prefix><component :is="h(SearchOutlined)" /></template>
      </a-input>
      <a-select
        v-model:value="kinds"
        mode="multiple"
        :options="kindOptions"
        :placeholder="t('ui.ontology.listKindPh')"
        class="ol-kinds"
        :max-tag-count="3"
      />
      <span class="ol-count mono">
        {{ filtered
          ? t('ui.ontology.listCountFiltered', { shown: rows.length, total: allRows.length })
          : t('ui.ontology.listCount', { n: allRows.length }) }}
      </span>
      <span v-if="usageWindow" class="ol-count mono" :class="{ 'is-partial': usageWindow.partial }">
        {{ t(usageWindow.partial ? 'ui.ontology.rangeCaptionPartial' : 'ui.ontology.rangeCaption', {
          from: usageWindow.from,
          to: usageWindow.to,
          days: usageWindow.days
        }) }}
      </span>
      <a-button
        v-if="filtered"
        size="small"
        type="text"
        :icon="h(CloseCircleOutlined)"
        @click="clearFilters"
      >{{ t('ui.ontology.listClear') }}</a-button>
    </div>

    <div class="ol-table-wrap">
      <a-table
        :columns="columns"
        :data-source="rows"
        :row-key="(r: Row) => r.id"
        :custom-row="rowProps"
        :pagination="{ current: page, pageSize: 40, size: 'small', showSizeChanger: false, hideOnSinglePage: true, onChange: (p: number) => (page = p) }"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div class="ol-name">
              <span class="ol-dot" :style="{ background: kindColor(record.kind) }" />
              <div class="ol-name-text">
                <span class="ol-name-main">{{ record.name }}</span>
                <span v-if="record.context" class="ol-context">{{ record.context }}</span>
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'kind'">
            <span class="ol-kind">{{ record.kindLabel }}</span>
          </template>
          <template v-else-if="column.key === 'events'">
            <span v-if="record.events != null" class="mono ol-usage">
              {{ compact(record.events) }}
              <span class="ol-usage-sub">{{ t('ui.ontology.listVisitors', { n: compact(record.visitors ?? 0) }) }}</span>
            </span>
            <span v-else class="ol-dash">—</span>
          </template>
          <template v-else-if="column.key === 'kpi'">
            <span v-if="record.kpi" class="mono ol-kpi">
              {{ compact(record.kpi.value) }}
              <span
                v-if="record.kpi.delta != null"
                class="ol-delta"
                :class="record.kpi.delta >= 0 ? 'is-up' : 'is-down'"
              >{{ record.kpi.delta >= 0 ? '▲' : '▼' }}{{ Math.abs(Math.round(record.kpi.delta * 100)) }}%</span>
            </span>
            <span v-else class="ol-dash">—</span>
          </template>
        </template>

        <template #emptyText>
          <div class="ol-empty">{{ t('ui.ontology.listNoMatch') }}</div>
        </template>
      </a-table>
    </div>
  </div>
</template>

<style scoped>
.ontology-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.ol-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--rule, #e5e0d5);
  background: var(--subtle);
  flex-wrap: wrap;
}
.ol-search { max-width: 320px; }
.ol-kinds { min-width: 220px; max-width: 380px; }
.ol-count {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
  margin-left: auto;
}
/* The second caption sits beside the first rather than being pushed to the far
   edge by another auto margin. */
.ol-count + .ol-count { margin-left: 12px; }
.ol-count.is-partial { color: var(--accent, #a8412b); }
.ol-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.ol-name { display: flex; align-items: flex-start; gap: 9px; }
.ol-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}
.ol-name-text { display: flex; flex-direction: column; min-width: 0; }
.ol-name-main {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 18, 'SOFT' 50;
  font-size: 14px;
  color: var(--ink);
  line-height: 1.3;
}
.ol-context {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 460px;
}
.ol-kind { font-size: 12px; color: var(--ink-2); }
.ol-usage { font-size: 12.5px; color: var(--ink); display: inline-flex; flex-direction: column; align-items: flex-end; }
.ol-usage-sub { font-size: 10.5px; color: var(--muted); }
.ol-kpi { font-size: 13px; color: var(--ink); }
.ol-delta { font-size: 11px; margin-left: 4px; }
.ol-delta.is-up { color: #5F7A4F; }
.ol-delta.is-down { color: var(--accent); }
.ol-dash { color: var(--muted); }
.ol-empty { padding: 32px; color: var(--muted); font-style: italic; }
.ontology-list :deep(.ol-row) { cursor: pointer; }
.ontology-list :deep(.ol-row:hover > td) { background: var(--subtle-2) !important; }
.ontology-list :deep(.ol-row.is-selected > td) {
  background: color-mix(in srgb, var(--accent) 10%, transparent) !important;
  box-shadow: inset 3px 0 0 var(--accent);
}
/* Sticky via CSS against .ol-table-wrap rather than a-table's `scroll.y`: that
   mode needs a fixed pixel height (which never matches this flex card) and
   injects an empty measure row under the header. */
.ontology-list :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 2;
  font-family: var(--sans);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--paper, #faf7f2);
}
</style>
