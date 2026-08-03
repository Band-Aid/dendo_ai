<script setup lang="ts">
import { computed, h } from 'vue'
import {
  EditOutlined,
  DeleteOutlined,
  QuestionCircleOutlined,
  CodeOutlined
} from '@ant-design/icons-vue'
import { useI18n } from '~/composables/useI18n'
import type { ConceptMetric, OntologyConcept, OntologyEdge } from '~/types/ontology'

const { t } = useI18n()

interface GraphNode {
  id: string
  kind: string
  name: string
  url?: string
  description?: string
}

const props = defineProps<{
  node: GraphNode
  concepts: OntologyConcept[]
  edges: OntologyEdge[]
  nodes: GraphNode[]
  metrics?: Record<string, { events30d: number; visitors30d: number }>
  conceptMetrics?: Record<string, ConceptMetric>
  /** Concepts lens hides unmeasured assets — areas expand on demand. */
  lens?: 'concepts' | 'all'
  areaExpanded?: boolean
  areaMemberCount?: number
}>()
const emit = defineEmits<{
  editConcept: [concept: OntologyConcept]
  deleteConcept: [conceptId: string]
  /** Ask this question NOW in the map's Ask panel (save-to-notebook comes after). */
  ask: [question: string]
  toggleArea: [areaId: string]
  close: []
}>()

const concept = computed(() =>
  props.node.kind === 'concept' ? props.concepts.find(c => c.id === props.node.id) ?? null : null
)

const nodeName = (id: string) => props.nodes.find(n => n.id === id)?.name ?? id
const usage = computed(() => props.metrics?.[props.node.id])

// --- Concept KPI ----------------------------------------------------------------

const kpi = computed(() =>
  concept.value ? props.conceptMetrics?.[concept.value.id] ?? null : null
)

const kpiValue = computed(() => {
  if (!kpi.value || kpi.value.error) return null
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    .format(kpi.value.value)
})

const kpiDeltaPct = computed(() =>
  kpi.value?.delta != null ? Math.round(kpi.value.delta * 100) : null
)

/** A move big enough to warrant walking the causes playbook. */
const kpiMoved = computed(() => kpiDeltaPct.value != null && Math.abs(kpiDeltaPct.value) >= 15)

/** Sparkline as a plain SVG polyline — no chart lib for 60 points. */
const sparkPoints = computed(() => {
  const series = kpi.value?.series
  if (!series || series.length < 2) return null
  const w = 240
  const hgt = 40
  const max = Math.max(...series.map(p => p.value))
  const min = Math.min(...series.map(p => p.value))
  const span = max - min || 1
  return series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * w
      const y = hgt - 3 - ((p.value - min) / span) * (hgt - 6)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

/** Concepts that measure this entity (reverse links, for entity nodes). */
const linkedConcepts = computed(() =>
  props.node.kind === 'concept'
    ? []
    : props.concepts.filter(c => c.measures.includes(props.node.id))
)

// --- Ask flow -----------------------------------------------------------------

/** Fill `{conceptName}` / `{entityName}` from context; fall back to a sane ask. */
function fillTemplate(template: string | undefined, fallback: string): string {
  const base = template?.trim() || fallback
  return base
    .replaceAll('{conceptName}', concept.value?.name ?? props.node.name)
    .replaceAll('{entityName}', concept.value?.measures.map(nodeName).slice(0, 3).join(', ') || props.node.name)
}

function askAbout(template: string | undefined, fallback: string) {
  emit('ask', fillTemplate(template, fallback))
}

// Fallback question builders live in script — quote/backtick soup inside Vue
// template attributes doesn't parse.
function causeFallback(causeText: string | undefined): string {
  const name = concept.value?.name ?? props.node.name
  return `Is "${causeText ?? 'this factor'}" driving changes in ${name}? Investigate with data.`
}
function actionFallback(actionTitle: string): string {
  const name = concept.value?.name ?? props.node.name
  return `What data would tell us whether to "${actionTitle}" for ${name}?`
}
function entityFallback(): string {
  return `How is "${props.node.name}" performing? Show usage trends over the last 30 days and highlight anything unusual.`
}
</script>

<template>
  <div class="ndp">
    <header class="ndp-head">
      <div class="ndp-title-block">
        <span class="ndp-kind">{{ t(`ui.ontology.legend.${node.kind}`) }}</span>
        <h3 class="ndp-title">{{ node.name }}</h3>
      </div>
      <a-button size="small" type="text" @click="emit('close')">✕</a-button>
    </header>

    <!-- Usage overlay (entities) -->
    <div v-if="usage" class="ndp-usage mono">
      {{ t('ui.ontology.overlayLabel', { n: usage.events30d.toLocaleString() }) }} ·
      {{ t('ui.ontology.visitorsLabel', { n: usage.visitors30d.toLocaleString() }) }}
    </div>

    <div v-if="node.url" class="ndp-prop mono">{{ node.url }}</div>
    <p v-if="node.description" class="ndp-desc">{{ node.description }}</p>

    <!-- Concept detail -->
    <template v-if="concept">
      <!-- Live KPI headline -->
      <div v-if="kpiValue" class="ndp-kpi">
        <div class="ndp-kpi-row">
          <span class="ndp-kpi-value">{{ kpiValue }}</span>
          <span
            v-if="kpiDeltaPct != null"
            class="ndp-kpi-delta"
            :class="kpiDeltaPct >= 0 ? 'ndp-kpi-delta--up' : 'ndp-kpi-delta--down'"
          >{{ kpiDeltaPct >= 0 ? '▲' : '▼' }} {{ Math.abs(kpiDeltaPct) }}%</span>
        </div>
        <span class="ndp-kpi-label mono">{{ kpi!.label }}</span>
        <svg v-if="sparkPoints" class="ndp-spark" viewBox="0 0 240 40" preserveAspectRatio="none">
          <polyline :points="sparkPoints" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </div>
      <div v-else-if="kpi?.error" class="ndp-kpi-error mono">{{ t('ui.ontology.kpiError', { detail: kpi.error }) }}</div>

      <p class="ndp-definition">{{ concept.definition }}</p>

      <div v-if="concept.dslTemplate" class="ndp-section">
        <span class="ndp-section-label"><component :is="h(CodeOutlined)" /> {{ t('ui.ontology.dslTemplate') }}</span>
        <pre class="ndp-dsl">{{ concept.dslTemplate }}</pre>
      </div>

      <div v-if="concept.measures.length" class="ndp-section">
        <span class="ndp-section-label">{{ t('ui.ontology.measures') }}</span>
        <div class="ndp-chips">
          <span v-for="id in concept.measures" :key="id" class="ndp-chip">{{ nodeName(id) }}</span>
        </div>
      </div>

      <div v-if="concept.causes.length" class="ndp-section">
        <p v-if="kpiMoved" class="ndp-moved">{{ t('ui.ontology.kpiMoved') }}</p>
        <span class="ndp-section-label">{{ t('ui.ontology.causes') }}</span>
        <div v-for="cause in concept.causes" :key="cause.id" class="ndp-item">
          <span class="ndp-item-text">{{ cause.text || nodeName(cause.conceptId || '') }}</span>
          <a-button
            size="small"
            type="text"
            :icon="h(QuestionCircleOutlined)"
            @click="askAbout(cause.questionTemplate, causeFallback(cause.text))"
          >{{ t('ui.ontology.ask') }}</a-button>
        </div>
      </div>

      <div v-if="concept.actions.length" class="ndp-section">
        <span class="ndp-section-label">{{ t('ui.ontology.actions') }}</span>
        <div v-for="action in concept.actions" :key="action.id" class="ndp-item">
          <div class="ndp-item-body">
            <span class="ndp-item-text">{{ action.title }}</span>
            <span v-if="action.description" class="ndp-item-sub">{{ action.description }}</span>
          </div>
          <a-button
            size="small"
            type="text"
            :icon="h(QuestionCircleOutlined)"
            @click="askAbout(action.questionTemplate, actionFallback(action.title))"
          >{{ t('ui.ontology.ask') }}</a-button>
        </div>
      </div>

      <footer class="ndp-foot">
        <a-button size="small" :icon="h(EditOutlined)" @click="emit('editConcept', concept)">
          {{ t('ui.ontology.editConcept') }}
        </a-button>
        <a-popconfirm
          :title="t('ui.ontology.deleteConfirm')"
          @confirm="emit('deleteConcept', concept.id)"
        >
          <a-button size="small" danger type="text" :icon="h(DeleteOutlined)">
            {{ t('ui.ontology.deleteConcept') }}
          </a-button>
        </a-popconfirm>
      </footer>
    </template>

    <!-- Entity: linked concepts + generic ask -->
    <template v-else>
      <!-- Product area under the concepts lens: members are hidden — expand on demand. -->
      <div v-if="node.kind === 'productArea' && lens === 'concepts' && (areaMemberCount ?? 0) > 0" class="ndp-section">
        <a-button size="small" @click="emit('toggleArea', node.id)">
          {{ areaExpanded ? t('ui.ontology.hideMembers') : t('ui.ontology.showMembers', { n: areaMemberCount }) }}
        </a-button>
      </div>
      <div v-if="linkedConcepts.length" class="ndp-section">
        <span class="ndp-section-label">{{ t('ui.ontology.linkedConcepts') }}</span>
        <div class="ndp-chips">
          <span v-for="c in linkedConcepts" :key="c.id" class="ndp-chip ndp-chip--concept">{{ c.name }}</span>
        </div>
      </div>
      <footer class="ndp-foot">
        <a-button
          size="small"
          type="primary"
          :icon="h(QuestionCircleOutlined)"
          @click="askAbout(undefined, entityFallback())"
        >{{ t('ui.ontology.askAboutEntity') }}</a-button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.ndp {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
}
.ndp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.ndp-kind {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
}
.ndp-title {
  margin: 2px 0 0;
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 24, 'SOFT' 40;
  font-size: 18px;
  line-height: 1.25;
  color: var(--ink);
}
.ndp-usage {
  font-size: 12px;
  color: var(--ink-2);
  background: var(--subtle);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  padding: 6px 10px;
}
.ndp-prop { font-size: 11.5px; color: var(--muted); word-break: break-all; }
.ndp-kpi {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--subtle);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
}
.ndp-kpi-row { display: flex; align-items: baseline; gap: 10px; }
.ndp-kpi-value {
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 500;
  line-height: 1.1;
  color: var(--ink);
}
.ndp-kpi-delta { font-size: 12.5px; font-weight: 600; }
.ndp-kpi-delta--up { color: var(--ok, #4a7a3a); }
.ndp-kpi-delta--down { color: var(--accent-deep, #8a3422); }
.ndp-kpi-label { font-size: 10.5px; color: var(--muted); }
.ndp-spark { width: 100%; height: 40px; color: var(--accent); margin-top: 2px; }
.ndp-kpi-error { font-size: 11px; color: var(--muted); }
.ndp-moved {
  margin: 0;
  font-size: 12px;
  color: var(--accent-deep, #8a3422);
  font-weight: 500;
}
.ndp-desc, .ndp-definition {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink);
  margin: 0;
}
.ndp-section { display: flex; flex-direction: column; gap: 6px; }
.ndp-section-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ndp-dsl {
  background: var(--code-bg, #1f1a14);
  color: var(--code-fg, #f5f2ec);
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}
.ndp-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.ndp-chip {
  font-size: 11.5px;
  padding: 2px 8px;
  background: var(--subtle);
  border: 1px solid var(--rule);
  border-radius: 999px;
  color: var(--ink-2);
}
.ndp-chip--concept { background: var(--accent-soft); color: var(--accent-deep, #8a3422); }
.ndp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--rule-soft, var(--rule));
  border-radius: var(--r-sm);
}
.ndp-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ndp-item-text { font-size: 13px; color: var(--ink); }
.ndp-item-sub { font-size: 11.5px; color: var(--muted); }
.ndp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--rule-soft, var(--rule));
}
</style>
