<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, PieChart, ScatterChart, HeatmapChart, FunnelChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, TitleComponent, LegendComponent, VisualMapComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { useResizeObserver } from '@vueuse/core'
import { buildChartOption, metricCards, formatMetric, chartIssue } from '~/utils/chartEngine'
import type { ChartOptions, ChartSeries, ChartType } from '~/types/notebook'

echarts.use([LineChart, BarChart, PieChart, ScatterChart, HeatmapChart, FunnelChart,
  GridComponent, TooltipComponent, TitleComponent, LegendComponent, VisualMapComponent, AriaComponent, SVGRenderer])

const props = withDefaults(defineProps<{
  type: ChartType; xField?: string; yField?: string; rows?: Record<string, unknown>[]
  series?: ChartSeries[]; title?: string; options?: ChartOptions; height?: number
}>(), { height: 320 })
const el = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null
const input = computed(() => ({ ...props.options, chartType: props.type, xField: props.xField, yField: props.yField, rows: props.rows, series: props.series, title: props.title }))
const issue = computed(() => chartIssue(input.value))
const cards = computed(() => metricCards(input.value))
const aggregationLabels = { sum: 'Total', average: 'Average', min: 'Minimum', max: 'Maximum', last: 'Latest value' }
const description = computed(() => `${props.title || props.yField || 'Data visualization'} · ${props.type}`)
function resizeChart() {
  chart?.resize()
  // ECharts uses fixed SVG dimensions. A viewBox lets print and standalone
  // exports scale the same geometry when their container is narrower.
  const svg = el.value?.querySelector('svg')
  if (svg) {
    svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`)
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet')
  }
}
function render() {
  if (!el.value || props.type === 'metric' || issue.value) { chart?.dispose(); chart = null; return }
  if (!chart) chart = echarts.init(el.value, undefined, { renderer: 'svg' })
  chart.setOption(buildChartOption(input.value), true)
  resizeChart()
}
watch(input, async () => { await nextTick(); render() }, { deep: true })
useResizeObserver(el, resizeChart)
onMounted(render)
onBeforeUnmount(() => { chart?.dispose(); chart = null })
</script>

<template>
  <div class="visualization" :aria-label="description">
    <div v-if="issue" class="chart-empty" role="status">{{ issue }}</div>
    <div v-else-if="type === 'metric'" class="metric-cards">
      <div v-for="(card, index) in cards" :key="index" class="metric-card">
        <span class="metric-label">{{ card.name }}</span>
        <strong class="metric-value">{{ formatMetric(card.value, options) }}</strong>
        <span v-if="options?.target != null" class="metric-target">Target {{ formatMetric(options.target, options) }}<template v-if="card.value !== null"> · {{ formatMetric(card.value - options.target, options) }} vs target</template></span>
        <span class="metric-method">{{ aggregationLabels[options?.aggregation || 'sum'] }}<template v-if="options?.yAxisLabel"> · {{ options.yAxisLabel }}</template></span>
      </div>
    </div>
    <div v-else ref="el" role="img" :aria-label="description" :style="{ width: '100%', height: `${height}px` }" />
  </div>
</template>

<style scoped>
.visualization { width: 100%; min-width: 0; }
.chart-empty { padding: 48px 24px; color: var(--muted, #79766E); text-align: center; border: 1px dashed var(--rule, #E8E2D6); border-radius: 8px; }
.metric-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 24px; padding: 18px 0; }
.metric-card { display: flex; flex-direction: column; gap: 8px; }
.metric-label { font-size: 13px; color: #79766E; }
.metric-value { font-size: clamp(30px, 4vw, 48px); line-height: 1.1; letter-spacing: -0.045em; color: #141513; }
.metric-target { font-size: 12px; color: #3C3A35; }
.metric-method { font-size: 11px; color: #79766E; }
</style>
