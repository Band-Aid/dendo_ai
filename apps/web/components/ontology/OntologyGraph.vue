<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useResizeObserver } from '@vueuse/core'
import { useI18n } from '~/composables/useI18n'
import { ONTOLOGY_KINDS, KIND_COLORS, KIND_INDEX } from '~/composables/useOntologyKinds'
import type { ConceptMetric, OntologyEdge } from '~/types/ontology'

// Registered locally (module-scoped, additive) — ChartRenderer registers its
// own set the same way; echarts.use is idempotent per component type.
echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer])

const { t } = useI18n()

interface GraphNode {
  id: string
  kind: string
  name: string
  url?: string
}

interface Props {
  nodes: GraphNode[]
  edges: OntologyEdge[]
  /** node id → usage; sizes the nodes. Optional — graph renders without it. */
  metrics?: Record<string, { events: number; visitors: number }>
  /** concept id → live KPI; painted into concept labels. */
  conceptMetrics?: Record<string, ConceptMetric>
  selectedId?: string | null
  /** Subgraph of the current question — highlighted; everything else dims. */
  highlightIds?: string[] | null
}

const props = defineProps<Props>()
const emit = defineEmits<{ select: [nodeId: string | null] }>()

/**
 * What the highlight/dim treatment applies to.
 *
 * ECharts' `emphasis.focus: 'adjacency'` only lasts as long as the cursor is
 * over a node, so selecting one used to leave nothing but a thin border — the
 * neighbourhood you clicked to inspect vanished the moment you moved the mouse
 * away to read the detail panel. Selection therefore derives the same adjacency
 * set that hovering shows, and renders it through the existing highlight path
 * so it persists until you select something else.
 *
 * An explicit `highlightIds` (the Ask panel's answer subgraph) wins: it is a
 * deliberate, larger claim about what matters right now, and clicking a node
 * inside it to read the details shouldn't collapse it to that node's immediate
 * neighbours.
 */
function highlightSet(): Set<string> | null {
  if (props.highlightIds?.length) return new Set(props.highlightIds)
  if (!props.selectedId) return null
  const adjacent = new Set<string>([props.selectedId])
  for (const e of props.edges) {
    if (e.from === props.selectedId) adjacent.add(e.to)
    else if (e.to === props.selectedId) adjacent.add(e.from)
  }
  return adjacent
}

const el = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

// Category order drives legend + palette assignment.
const categories = computed(() =>
  ONTOLOGY_KINDS.map((k, i) => ({ name: t(`ui.ontology.legend.${k}`), itemStyle: { color: KIND_COLORS[i] } }))
)

/** Log-scaled node size so one hot feature doesn't dwarf the map. */
function symbolSize(nodeId: string, kind: string): number {
  // KPI-bearing concepts read as scorecard entries — slightly larger.
  if (kind === 'concept') return kpiFor(nodeId) ? 32 : 26
  const base = kind === 'productArea' ? 20 : 12
  const m = props.metrics?.[nodeId]
  if (!m || m.events <= 0) return base
  return Math.min(46, base + Math.log10(1 + m.events) * 5)
}

function kpiFor(nodeId: string): ConceptMetric | undefined {
  const m = props.conceptMetrics?.[nodeId]
  return m && !m.error ? m : undefined
}

const compactNumber = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/** "Agent Mode Retention\n1.2K ▼12%" — the KPI painted under the name. */
function conceptLabel(nodeId: string, name: string): string {
  const m = kpiFor(nodeId)
  if (!m) return name
  const delta = m.delta != null
    ? ` ${m.delta >= 0 ? '▲' : '▼'}${Math.abs(Math.round(m.delta * 100))}%`
    : ''
  return `${name}\n${compactNumber(m.value)}${delta}`
}

// --- Layout stability ----------------------------------------------------------
/**
 * The force simulation runs ONCE per node set; every node is then pinned where
 * it landed and the series switches to `layout: 'none'`. Two separate causes of
 * "the map bounces around", both fixed here:
 *
 *  1. ECharts restarts the simulation on any `setOption` that carries `data`,
 *     so merely *selecting* a node — or the usage overlay / concept KPIs
 *     arriving a second later — re-shuffled the entire map out from under you.
 *  2. A node with no explicit x/y is seeded with `Math.random()`
 *     (echarts/lib/chart/graph/forceHelper.js), so the same workspace laid out
 *     differently on every visit and you could never learn where anything sits.
 *
 * Dragging survives: under `layout: 'none'` ECharts writes the dragged position
 * back to the item layout, and the next capture picks it up — so a manual
 * arrangement sticks instead of being sprung back by the physics.
 *
 * One deliberate consequence: ECharts derives the view's bounding box from the
 * declared x/y (graph/createView.js). With no x/y it used to fall back to the
 * whole container, so the scale never changed; now the map auto-fits its
 * contents. That frames it better, and it re-frames when the node SET changes —
 * a lens switch, expanding an area, a sync. Selection, highlighting and the
 * usage/KPI overlays all leave the set alone, so none of them move anything.
 */
const positions = new Map<string, [number, number]>()

/**
 * Deterministic seed position from the node id alone. Hashing the *id* rather
 * than indexing into a spiral means adding or removing nodes (a sync, a lens
 * switch) leaves every other node's starting point untouched.
 */
function seedPosition(id: string): [number, number] {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const angleU = ((h >>> 16) & 0xffff) / 0x10000
  const radiusU = (h & 0xffff) / 0x10000
  const angle = angleU * Math.PI * 2
  // sqrt keeps the seeds evenly spread by area instead of clumping at the centre.
  const radius = 40 + Math.sqrt(radiusU) * 220
  return [Math.cos(angle) * radius, Math.sin(angle) * radius]
}

/**
 * Read the settled positions back out of the chart. Uses ECharts' internal
 * model accessor, so it is wrapped: if it ever stops working we simply never
 * pin, and the graph behaves exactly as it did before this optimisation.
 */
function captureLayout(): boolean {
  try {
    const data = (chart as any)?.getModel()?.getSeriesByIndex(0)?.getData?.()
    if (!data?.each) return false
    let captured = 0
    data.each((i: number) => {
      const p = data.getItemLayout(i)
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        positions.set(data.getId(i), [p[0], p[1]])
        captured++
      }
    })
    return captured > 0
  } catch {
    return false
  }
}

/**
 * Animating the simulation on a large graph is the lesser evil — running it to
 * convergence synchronously would freeze the tab. Above this many nodes we keep
 * the animation and pin once it has settled.
 */
const ANIMATE_ABOVE = 400

/** friction decays 0.992× per 16ms step and the run ends below 0.01. */
function settleMs(friction: number): number {
  return Math.ceil(Math.log(0.01 / friction) / Math.log(0.992)) * 16 + 600
}

function buildOption() {
  const highlight = highlightSet()
  // Pin only when every visible node has a known position; a single new node
  // (lens switch, fresh sync) drops back to force for one pass, with the
  // existing nodes held fixed so only the newcomer finds a home.
  const pinned = props.nodes.length > 0 && props.nodes.every(n => positions.has(n.id))

  const data = props.nodes.map(n => {
    const isHighlighted = highlight?.has(n.id) ?? false
    const at = positions.get(n.id) ?? seedPosition(n.id)
    return {
      id: n.id,
      name: n.name,
      x: at[0],
      y: at[1],
      fixed: positions.has(n.id),
      category: KIND_INDEX[n.kind] ?? 1,
      symbolSize: symbolSize(n.id, n.kind),
      symbol: n.kind === 'concept' ? 'diamond' : 'circle',
      label: {
        show: highlight
          ? isHighlighted
          : n.kind === 'concept' || n.kind === 'productArea' || props.nodes.length <= 40,
        fontSize: n.kind === 'concept' ? 12 : 10,
        ...(n.kind === 'concept' ? { formatter: conceptLabel(n.id, n.name), lineHeight: 15 } : {})
      },
      itemStyle: {
        ...(n.id === props.selectedId ? { borderColor: '#141513', borderWidth: 2.5 } : {}),
        ...(highlight && isHighlighted && n.id !== props.selectedId
          ? { borderColor: '#A8412B', borderWidth: 2 }
          : {}),
        ...(highlight && !isHighlighted ? { opacity: 0.15 } : {})
      }
    }
  })

  const links = props.edges.map(e => {
    const inHighlight = highlight ? highlight.has(e.from) && highlight.has(e.to) : null
    return {
      source: e.from,
      target: e.to,
      lineStyle: {
        type: e.type === 'causes' ? 'dashed' as const : 'solid' as const,
        opacity: inHighlight === null
          ? (e.type === 'belongs_to' ? 0.22 : 0.55)
          : inHighlight ? 0.8 : 0.06,
        width: inHighlight ? 2 : e.type === 'belongs_to' ? 1 : 1.6,
        curveness: 0.08
      }
    }
  })

  // Force params scale with graph size: a big graph needs weaker repulsion,
  // shorter edges and stronger gravity/friction so it pulls together and
  // settles quickly instead of sprawling and drifting for many seconds.
  const n = props.nodes.length
  const force =
    n > 300
      ? { repulsion: 55, edgeLength: [24, 70] as [number, number], gravity: 0.28, friction: 0.35 }
      : n > 120
        ? { repulsion: 110, edgeLength: [32, 100] as [number, number], gravity: 0.18, friction: 0.28 }
        : { repulsion: 180, edgeLength: [40, 130] as [number, number], gravity: 0.1, friction: 0.2 }

  const animate = !pinned && n > ANIMATE_ABOVE

  const option = {
    tooltip: {
      formatter: (p: any) => {
        if (p.dataType !== 'node') return ''
        const node = props.nodes.find(n => n.id === p.data?.id)
        if (!node) return p.name
        const m = props.metrics?.[node.id]
        const kindLabel = t(`ui.ontology.legend.${node.kind}`)
        const usage = m
          ? `<br/>${t('ui.ontology.overlayLabel', { n: m.events.toLocaleString() })} · ${t('ui.ontology.visitorsLabel', { n: m.visitors.toLocaleString() })}`
          : ''
        return `<strong>${node.name}</strong><br/><span style="opacity:0.7">${kindLabel}</span>${usage}`
      }
    },
    legend: { data: categories.value.map(c => c.name), bottom: 4, itemWidth: 12, itemHeight: 12, textStyle: { fontSize: 11 } },
    series: [{
      type: 'graph',
      // Once every node is pinned there is nothing left to simulate, so drop
      // the physics entirely. Roam and drag both still work under 'none'.
      layout: pinned ? 'none' : 'force',
      roam: true,
      draggable: true,
      // layoutAnimation false runs the simulation to convergence inside this
      // setOption call — one paint, already settled, instead of ~8 seconds of
      // visible drift. Only very large graphs keep the animation, to avoid
      // blocking the main thread.
      force: { ...force, layoutAnimation: animate },
      categories: categories.value,
      data,
      links,
      emphasis: { focus: 'adjacency', label: { show: true } },
      lineStyle: { color: 'source' },
      scaleLimit: { min: 0.3, max: 4 }
    }]
  }

  return { option, pinned, animate, settleAfter: settleMs(force.friction) }
}

/**
 * A signature of graph TOPOLOGY only (which nodes/edges exist) — not of the
 * cosmetic props (selection, highlight, metrics). Re-laying-out the force graph
 * is only warranted when topology actually changes; doing it on a mere
 * selection or when the usage overlay loads is what made the map "jump".
 */
function topologySig(): string {
  return `${props.nodes.map(n => n.id).join('|')}::${props.edges.map(e => `${e.from}>${e.to}`).join('|')}`
}
let lastSig = ''
/** Signature we have already run a settle-and-pin pass for — stops the pin
 *  re-render from looping if a position can't be read back for some node. */
let pinnedSig = ''
let settleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * notMerge (full re-layout) only when topology changed; otherwise merge in
 * place so ECharts keeps every node's computed position.
 *
 * After any pass that had to run the physics, the settled positions are
 * captured and the graph is re-rendered pinned — so that is the *only* moment
 * nodes ever move.
 */
function render() {
  if (!chart) return
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }

  // Absorb anything the user dragged since the last pass, so a hand-placed node
  // isn't snapped back to where the simulation had put it.
  if (positions.size) captureLayout()

  const sig = topologySig()
  const topologyChanged = sig !== lastSig
  if (topologyChanged) pinnedSig = ''
  lastSig = sig

  const { option, pinned, animate, settleAfter } = buildOption()
  chart.setOption(option as any, topologyChanged)
  if (pinned || pinnedSig === sig) return

  // Un-pinned pass: the simulation just ran (synchronously unless `animate`).
  // Grab where it landed and re-render with everything nailed down.
  pinnedSig = sig
  const pin = () => {
    settleTimer = null
    if (chart && captureLayout()) render()
  }
  if (animate) settleTimer = setTimeout(pin, settleAfter)
  else pin()
}

function init() {
  if (chart || !el.value) return
  chart = echarts.init(el.value)
  lastSig = ''
  render()
  chart.on('click', (p: any) => {
    emit('select', p?.dataType === 'node' ? (p.data?.id ?? null) : null)
  })
  // Clicking empty canvas clears the selection.
  chart.getZr().on('click', (ev: any) => {
    if (!ev.target) emit('select', null)
  })
}

watch(
  () => [props.nodes, props.edges, props.metrics, props.conceptMetrics, props.selectedId, props.highlightIds],
  () => render(),
  { deep: true }
)

useResizeObserver(el, () => chart?.resize())
onMounted(init)
onBeforeUnmount(() => {
  if (settleTimer) clearTimeout(settleTimer)
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" class="ontology-graph" />
</template>

<style scoped>
.ontology-graph {
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
