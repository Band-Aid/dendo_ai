<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import {
  SyncOutlined,
  DeleteOutlined,
  QuestionCircleOutlined,
  BulbOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import OntologyGraph from '~/components/ontology/OntologyGraph.vue'
import OntologyList from '~/components/ontology/OntologyList.vue'
import NodeDetailPanel from '~/components/ontology/NodeDetailPanel.vue'
import ConceptEditor from '~/components/ontology/ConceptEditor.vue'
import SuggestDrawer from '~/components/ontology/SuggestDrawer.vue'
import AskPanel from '~/components/ontology/AskPanel.vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'
import type { OntologyGraphResponse, OntologyConcept, OverlayMetrics, ConceptMetricsBlob } from '~/types/ontology'

const { t, locale } = useI18n()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()
const router = useRouter()

const loading = ref(false)
const syncing = ref(false)
const overlayLoading = ref(false)

const graph = ref<OntologyGraphResponse | null>(null)
const overlay = ref<OverlayMetrics | null>(null)
const conceptMetrics = ref<ConceptMetricsBlob | null>(null)
const selectedId = ref<string | null>(null)

const editorOpen = ref(false)
const editingConcept = ref<OntologyConcept | null>(null)
const suggestOpen = ref(false)

// --- Ask-from-the-map ---------------------------------------------------------
// Asking happens HERE; saving to a notebook is the optional next step inside
// the panel. While a result is showing, `askHighlightIds` dims the graph down
// to the question's connected subgraph.
const askOpen = ref(false)
const askQuestion = ref('')
const askOrigin = ref<string | null>(null)
const askAutoRun = ref(false)
const askHighlightIds = ref<string[]>([])

/** From a node's cause/action/entity button — prefilled, runs immediately. */
function handleAsk(question: string) {
  askQuestion.value = question
  askOrigin.value = selectedId.value
  askAutoRun.value = true
  askOpen.value = true
}

/** From the header button — blank slate, user types. */
function openAsk() {
  askQuestion.value = ''
  askOrigin.value = selectedId.value
  askAutoRun.value = false
  askOpen.value = true
}

function headers() {
  return { 'x-org-id': currentOrgId.value }
}

const selectedNode = computed(() =>
  selectedId.value ? graph.value?.nodes.find(n => n.id === selectedId.value) ?? null : null
)

// --- Lens: concept-first vs everything ------------------------------------------
// Big synced workspaces are unreadable as a full asset dump — default to the
// business layer (concepts + areas + measured entities) and let raw assets be
// detail-on-demand. The panel and editors keep the FULL node list; only what
// the <OntologyGraph> renders is filtered.
const lens = ref<'concepts' | 'all'>('all')
const lensTouched = ref(false)
const expandedAreas = ref<Set<string>>(new Set())

// --- View: map vs list ----------------------------------------------------------
// A force graph is good at showing shape and bad at answering "where is X?".
// The list is the index: every concept and asset, searchable, no lens applied.
const view = ref<'map' | 'list'>('map')

/**
 * Picking a row selects it for the detail panel. If the concepts lens would
 * hide that node on the map, widen to all assets — otherwise switching back to
 * the map would show a detail panel for something that isn't drawn.
 */
function selectFromList(nodeId: string) {
  selectedId.value = nodeId
  if (lens.value === 'concepts' && !visibleNodes.value.some(n => n.id === nodeId)) {
    lens.value = 'all'
    lensTouched.value = true
  }
}

function applyDefaultLens() {
  if (lensTouched.value || !graph.value) return
  lens.value = graph.value.concepts.length > 0 && graph.value.nodes.length > 150
    ? 'concepts'
    : 'all'
}

/** Feature members per product area (from belongs_to edges). */
const areaMembers = computed(() => {
  const members = new Map<string, string[]>()
  for (const e of graph.value?.edges ?? []) {
    if (e.type !== 'belongs_to') continue
    if (!members.has(e.to)) members.set(e.to, [])
    members.get(e.to)!.push(e.from)
  }
  return members
})

const visibleNodes = computed(() => {
  const g = graph.value
  if (!g || lens.value === 'all') return g?.nodes ?? []
  const keep = new Set<string>()
  for (const n of g.nodes) {
    if (n.kind === 'concept' || n.kind === 'productArea') keep.add(n.id)
  }
  for (const c of g.concepts) for (const m of c.measures) keep.add(m)
  for (const areaId of expandedAreas.value) {
    for (const member of areaMembers.value.get(areaId) ?? []) keep.add(member)
  }
  // A question's highlighted subgraph must stay visible even through the lens.
  for (const id of askHighlightIds.value) keep.add(id)
  return g.nodes.filter(n => keep.has(n.id))
})

const visibleEdges = computed(() => {
  const g = graph.value
  if (!g || lens.value === 'all') return g?.edges ?? []
  const ids = new Set(visibleNodes.value.map(n => n.id))
  return g.edges.filter(e => ids.has(e.from) && ids.has(e.to))
})

function toggleArea(areaId: string) {
  const next = new Set(expandedAreas.value)
  if (next.has(areaId)) next.delete(areaId)
  else next.add(areaId)
  expandedAreas.value = next
}

const entityOptions = computed(() =>
  (graph.value?.nodes ?? []).filter(n => n.kind !== 'concept') as Array<{ id: string; kind: string; name: string }>
)

const isEmpty = computed(() =>
  !!graph.value && graph.value.nodes.length === 0
)

async function load() {
  loading.value = true
  try {
    graph.value = await apiFetch<OntologyGraphResponse>('/api/ontology', { headers: headers() })
    applyDefaultLens()
  } catch (err: any) {
    message.error(err.message || 'Failed to load ontology')
  } finally {
    loading.value = false
  }
}

/** Non-blocking usage overlay — the graph renders fine without it. */
async function loadOverlay(force = false) {
  if (!graph.value?.meta.pendoConfigured) return
  overlayLoading.value = true
  try {
    overlay.value = await apiFetch<OverlayMetrics>('/api/ontology/overlay', {
      method: 'POST',
      headers: headers(),
      body: { force }
    })
    if (overlay.value?.errors) {
      const parts = Object.entries(overlay.value.errors).map(([k, v]) => `${k}: ${v}`)
      message.warning(t('ui.ontology.overlayPartial', { detail: parts.join('; ') }))
    }
  } catch (err: any) {
    // Overlay failure is non-fatal — the map just renders un-sized.
    message.warning(err.message || 'Usage overlay unavailable')
  } finally {
    overlayLoading.value = false
  }
}

/** Non-blocking concept KPIs — same posture as the overlay. */
async function loadConceptMetrics(force = false) {
  if (!graph.value?.meta.pendoConfigured || !graph.value.concepts.length) return
  try {
    conceptMetrics.value = await apiFetch<ConceptMetricsBlob>('/api/ontology/concept-metrics', {
      method: 'POST',
      headers: headers(),
      body: { force }
    })
  } catch (err: any) {
    message.warning(err.message || 'Concept KPIs unavailable')
  }
}

const resetting = ref(false)

/** Wipe structure + concepts + overlay cache and rebuild fresh from Pendo. */
async function resetMap() {
  resetting.value = true
  try {
    const res = await apiFetch<{ resynced: boolean; counts?: Record<string, number> }>(
      '/api/ontology/reset',
      { method: 'POST', headers: headers(), body: { resync: true } }
    )
    selectedId.value = null
    overlay.value = null
    conceptMetrics.value = null
    if (res.resynced && res.counts) {
      message.success(t('ui.ontology.resetDone', {
        features: res.counts.features,
        pages: res.counts.pages,
        segments: res.counts.segments
      }))
    } else {
      message.success(t('ui.ontology.resetCleared'))
    }
    await load()
    loadOverlay(true)
    loadConceptMetrics(true)
  } catch (err: any) {
    message.error(err.message || 'Reset failed')
  } finally {
    resetting.value = false
  }
}

async function sync() {
  syncing.value = true
  try {
    const res = await apiFetch<{ counts: Record<string, number>; truncated: boolean }>(
      '/api/ontology/sync',
      { method: 'POST', headers: headers(), body: {} }
    )
    message.success(t('ui.ontology.syncSuccess', {
      features: res.counts.features,
      pages: res.counts.pages,
      segments: res.counts.segments
    }))
    await load()
    loadOverlay()
    loadConceptMetrics()
  } catch (err: any) {
    message.error(err.message || t('ui.ontology.syncError'))
  } finally {
    syncing.value = false
  }
}

function openNewConcept() {
  editingConcept.value = null
  editorOpen.value = true
}

function openEditConcept(concept: OntologyConcept) {
  editingConcept.value = concept
  editorOpen.value = true
}

/** An ask auto-enriched existing concepts — refresh graph + their KPIs. */
async function onConceptsEvolved() {
  await load()
  loadConceptMetrics()
}

async function onConceptSaved(concept: OntologyConcept) {
  await load()
  selectedId.value = concept.id
  // The save invalidated this concept's cached KPI — recompute just it.
  loadConceptMetrics()
}

async function onDeleteConcept(conceptId: string) {
  try {
    await apiFetch(`/api/ontology/concepts/${conceptId}`, { method: 'DELETE', headers: headers() })
    message.success(t('ui.ontology.conceptDeleted'))
    if (selectedId.value === conceptId) selectedId.value = null
    await load()
  } catch (err: any) {
    message.error(err.message || 'Failed to delete concept')
  }
}

const lastSyncedLabel = computed(() => {
  const at = graph.value?.meta.syncedAt
  if (!at) return t('ui.ontology.neverSynced')
  return t('ui.ontology.lastSynced', {
    at: new Date(at).toLocaleString(locale.value === 'ja' ? 'ja-JP' : undefined)
  })
})

onMounted(async () => {
  await load()
  loadOverlay()
  loadConceptMetrics()
})
</script>

<template>
  <div class="ontology-page">
    <header class="op-head">
      <div class="op-title-block">
        <span class="eyebrow">{{ t('ui.ontology.eyebrow') }}</span>
        <h1 class="op-title">{{ t('ui.ontology.title') }}</h1>
        <p class="op-sub">
          {{ lastSyncedLabel }}
          <template v-if="graph?.meta.truncated"> · <span class="op-truncated">{{ t('ui.ontology.truncatedWarning') }}</span></template>
          <template v-if="graph?.meta.appIdMismatch"> · <span class="op-truncated">{{ t('ui.ontology.appIdMismatchWarning', { configured: graph.meta.appIdMismatch.configured, found: graph.meta.appIdMismatch.found.join(', ') }) }}</span></template>
        </p>
      </div>
      <div class="op-actions">
        <a-segmented
          :value="view"
          :options="[
            { label: t('ui.ontology.viewMap'), value: 'map' },
            { label: t('ui.ontology.viewList'), value: 'list' }
          ]"
          @change="(v: any) => (view = v)"
        />
        <a-segmented
          v-if="view === 'map' && graph && graph.concepts.length > 0"
          :value="lens"
          :options="[
            { label: t('ui.ontology.lensConcepts'), value: 'concepts' },
            { label: t('ui.ontology.lensAll'), value: 'all' }
          ]"
          @change="(v: any) => { lens = v; lensTouched = true }"
        />
        <a-button
          type="primary"
          ghost
          :icon="h(QuestionCircleOutlined)"
          @click="openAsk"
        >{{ t('ui.ontology.askButton') }}</a-button>
        <a-tooltip :title="t('ui.ontology.refreshOverlayTip')">
          <a-button
            :icon="h(ReloadOutlined)"
            :loading="overlayLoading"
            :disabled="!graph?.meta.pendoConfigured"
            @click="loadOverlay(true); loadConceptMetrics(true)"
          >{{ t('ui.ontology.refreshOverlay') }}</a-button>
        </a-tooltip>
        <a-button :icon="h(BulbOutlined)" @click="suggestOpen = true">
          {{ t('ui.ontology.suggest') }}
        </a-button>
        <a-button :icon="h(PlusOutlined)" @click="openNewConcept">
          {{ t('ui.ontology.newConcept') }}
        </a-button>
        <a-button
          type="primary"
          :icon="h(SyncOutlined)"
          :loading="syncing"
          :disabled="graph ? !graph.meta.pendoConfigured : false"
          @click="sync"
        >{{ t('ui.ontology.sync') }}</a-button>
        <a-popconfirm
          :title="t('ui.ontology.resetConfirm')"
          :ok-text="t('ui.ontology.resetOk')"
          ok-type="danger"
          @confirm="resetMap"
        >
          <a-button danger :icon="h(DeleteOutlined)" :loading="resetting">
            {{ t('ui.ontology.reset') }}
          </a-button>
        </a-popconfirm>
      </div>
    </header>

    <a-spin :spinning="loading" wrapper-class-name="op-spin">
      <!-- Empty states -->
      <div v-if="graph && isEmpty" class="op-empty">
        <template v-if="!graph.meta.pendoConfigured">
          <p>{{ t('ui.ontology.notConfigured') }}</p>
          <a-button type="primary" @click="router.push('/admin')">{{ t('ui.ontology.goToAdmin') }}</a-button>
        </template>
        <template v-else>
          <p>{{ t('ui.ontology.emptyState') }}</p>
          <a-button type="primary" :icon="h(SyncOutlined)" :loading="syncing" @click="sync">
            {{ t('ui.ontology.sync') }}
          </a-button>
        </template>
      </div>

      <!-- Graph + detail panel -->
      <div v-else-if="graph" class="op-body">
        <div class="op-graph-wrap">
          <template v-if="view === 'map'">
            <span v-if="lens === 'concepts'" class="op-lens-caption mono">
              {{ t('ui.ontology.lensShown', { shown: visibleNodes.length, total: graph.nodes.length }) }}
            </span>
            <OntologyGraph
              :nodes="visibleNodes"
              :edges="visibleEdges"
              :metrics="overlay?.metrics"
              :concept-metrics="conceptMetrics?.metrics"
              :selected-id="selectedId"
              :highlight-ids="askHighlightIds"
              @select="selectedId = $event"
            />
          </template>
          <OntologyList
            v-else
            :nodes="graph.nodes as any"
            :edges="graph.edges"
            :concepts="graph.concepts"
            :metrics="overlay?.metrics"
            :concept-metrics="conceptMetrics?.metrics"
            :selected-id="selectedId"
            @select="selectFromList"
          />
        </div>
        <aside v-if="selectedNode" class="op-panel">
          <NodeDetailPanel
            :node="selectedNode as any"
            :concepts="graph.concepts"
            :edges="graph.edges"
            :nodes="graph.nodes as any"
            :metrics="overlay?.metrics"
            :concept-metrics="conceptMetrics?.metrics"
            :lens="lens"
            :area-expanded="expandedAreas.has(selectedNode.id)"
            :area-member-count="areaMembers.get(selectedNode.id)?.length ?? 0"
            @toggle-area="toggleArea"
            @edit-concept="openEditConcept"
            @delete-concept="onDeleteConcept"
            @ask="handleAsk"
            @close="selectedId = null"
          />
        </aside>
      </div>
    </a-spin>

    <ConceptEditor
      :open="editorOpen"
      :concept="editingConcept"
      :entities="entityOptions"
      @close="editorOpen = false"
      @saved="onConceptSaved"
    />
    <SuggestDrawer
      :open="suggestOpen"
      @close="suggestOpen = false"
      @accepted="onConceptSaved"
    />
    <AskPanel
      :open="askOpen"
      :initial-question="askQuestion"
      :origin-node-id="askOrigin"
      :auto-run="askAutoRun"
      @close="askOpen = false"
      @related="askHighlightIds = $event"
      @evolved="onConceptsEvolved"
    />
  </div>
</template>

<style scoped>
.ontology-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--topbar-h, 56px) - 100px);
  min-height: 560px;
}
.op-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.op-title {
  margin: 2px 0 0;
  font-family: var(--serif);
  font-weight: 460;
  font-variation-settings: 'opsz' 36, 'SOFT' 40;
  font-size: 26px;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.op-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
.op-truncated { color: var(--accent); }
.op-actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* min-height:0 all the way down: a flex item defaults to min-height:auto and so
   refuses to shrink below its content, which let the list view's table push the
   card past the bottom of the window instead of scrolling inside it. */
.op-spin, .op-spin :deep(.ant-spin-container) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.op-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  border: 1px dashed var(--rule, #e5e0d5);
  border-radius: 10px;
  padding: 48px;
}
.op-empty p {
  max-width: 460px;
  text-align: center;
  color: var(--ink-2);
  font-size: 14.5px;
  line-height: 1.6;
  margin: 0;
}
.op-body {
  flex: 1;
  display: flex;
  gap: 0;
  border: 1px solid var(--rule, #e5e0d5);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface, #fff);
  min-height: 480px;
}
.op-graph-wrap { flex: 1; min-width: 0; min-height: 0; position: relative; }
.op-lens-caption {
  position: absolute;
  top: 10px;
  left: 14px;
  z-index: 2;
  font-size: 10.5px;
  color: var(--muted);
  background: color-mix(in srgb, var(--surface, #fff) 82%, transparent);
  padding: 2px 8px;
  border-radius: 999px;
}
.op-panel {
  width: 340px;
  flex-shrink: 0;
  border-left: 1px solid var(--rule, #e5e0d5);
  background: var(--paper, #faf7f2);
  overflow-y: auto;
}
</style>
