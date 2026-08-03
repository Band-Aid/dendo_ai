<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  TitleComponent,
  LegendComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useResizeObserver } from '@vueuse/core'
import { formatDateValue, isDateLike, DATE_COLUMN_NAME_RE } from '~/composables/useDateFormat'
import type { ChartSeries, ChartType } from '~/types/notebook'

echarts.use([
  LineChart, BarChart, PieChart,
  GridComponent, TooltipComponent, TitleComponent, LegendComponent,
  CanvasRenderer
])

interface Props {
  type: ChartType
  /**
   * Cell-level defaults — used when a series omits its own xField/yField, and
   * also used as the only data when `series` is empty (single-series legacy).
   */
  xField?: string
  yField?: string
  rows?: Record<string, unknown>[]
  /**
   * Multi-series mode. When set and non-empty the renderer plots one series
   * per entry. Series may have their own xField/yField overrides.
   */
  series?: ChartSeries[]
  title?: string
}

const props = defineProps<Props>()
const el = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const PALETTE = ['#A8412B', '#3C3A35', '#9C6A12', '#1E4D2B', '#5B6770', '#79766E', '#7C2A18', '#B89968']

/**
 * Format an x-axis value. Time columns (by name OR by value shape) become
 * short human-readable dates; everything else passes through unchanged.
 * The `fieldName` hint catches cases where the value is already an ISO string
 * but we want to ensure consistent date formatting.
 */
function formatXValue(v: unknown, fieldName?: string): string {
  const looksLikeDateField = fieldName ? DATE_COLUMN_NAME_RE.test(fieldName) : false
  if (looksLikeDateField || isDateLike(v)) {
    const formatted = formatDateValue(v)
    if (formatted) return formatted
  }
  return v == null ? '' : String(v)
}

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0
}

/**
 * Normalize props into a list of named series. Single-series legacy
 * (rows + xField + yField at the top level) becomes one untitled series.
 */
const normalizedSeries = computed<Array<Required<Pick<ChartSeries, 'name' | 'rows'>> & { xField: string; yField: string }>>(() => {
  const defaultX = props.xField ?? ''
  const defaultY = props.yField ?? ''

  if (props.series && props.series.length) {
    return props.series.map((s, idx) => ({
      name: s.name?.trim() || `Series ${idx + 1}`,
      rows: s.rows ?? [],
      xField: s.xField ?? defaultX,
      yField: s.yField ?? defaultY
    }))
  }
  return [{
    name: defaultY || 'value',
    rows: props.rows ?? [],
    xField: defaultX,
    yField: defaultY
  }]
})

const isMultiSeries = computed(() => (props.series?.length ?? 0) > 1)

function commonBase() {
  return {
    title: props.title ? { text: props.title, textStyle: { fontSize: 13, fontWeight: 500 } } : undefined,
    color: PALETTE,
    textStyle: { fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }
  }
}

function buildAxisOption(): echarts.EChartsCoreOption {
  // Build the union of x-values across all series so multiple time-series with
  // slightly different domains still line up. Order: preserve first appearance.
  const xValuesSet = new Set<string>()
  const ordered: string[] = []
  for (const s of normalizedSeries.value) {
    for (const r of s.rows) {
      const x = formatXValue(r[s.xField], s.xField)
      if (!xValuesSet.has(x)) {
        xValuesSet.add(x)
        ordered.push(x)
      }
    }
  }

  const series = normalizedSeries.value.map(s => {
    // Lookup per x-key so we don't assume matching row order across series.
    const byX = new Map<string, number>()
    for (const r of s.rows) {
      byX.set(formatXValue(r[s.xField], s.xField), toNumber(r[s.yField]))
    }
    return {
      name: s.name,
      type: props.type === 'line' ? 'line' : 'bar',
      data: ordered.map(x => byX.has(x) ? byX.get(x) : null),
      smooth: props.type === 'line',
      areaStyle: props.type === 'line' && !isMultiSeries.value ? { opacity: 0.12 } : undefined,
      itemStyle: { borderRadius: props.type === 'bar' ? [3, 3, 0, 0] : 0 },
      connectNulls: true
    }
  })

  return {
    ...commonBase(),
    tooltip: { trigger: 'axis' },
    legend: isMultiSeries.value ? { top: props.title ? 28 : 6, type: 'scroll', textStyle: { fontSize: 12 } } : undefined,
    xAxis: {
      type: 'category',
      data: ordered,
      axisLabel: { rotate: ordered.length > 12 ? 30 : 0 }
    },
    yAxis: { type: 'value' },
    series,
    grid: {
      left: 44,
      right: 20,
      top: (props.title ? 40 : 16) + (isMultiSeries.value ? 26 : 0),
      bottom: 40
    }
  }
}

function buildDonutOption(): echarts.EChartsCoreOption {
  // Two donut modes:
  //   - Multi-series (≥2 series): one slice per series, value = sum of yField
  //     across the series's rows. Ideal for "summary" charts where each agg
  //     response represents a single quantity (e.g. PES counts per persona).
  //   - Single-series: aggregate by x-field category, one slice per x value.
  let slices: Array<{ name: string; value: number }>

  if (isMultiSeries.value) {
    slices = normalizedSeries.value.map(s => ({
      name: s.name,
      value: s.rows.reduce((sum, r) => sum + toNumber(r[s.yField]), 0)
    }))
  } else {
    const totals = new Map<string, number>()
    const s = normalizedSeries.value[0]
    if (s) {
      for (const r of s.rows) {
        const k = formatXValue(r[s.xField], s.xField)
        totals.set(k, (totals.get(k) ?? 0) + toNumber(r[s.yField]))
      }
    }
    slices = [...totals.entries()].map(([name, value]) => ({ name, value }))
  }

  slices.sort((a, b) => b.value - a.value)

  return {
    ...commonBase(),
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => `${p.name}<br/><strong>${p.value}</strong> (${p.percent}%)`
    },
    legend: {
      orient: 'vertical',
      right: 8,
      top: 'middle',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { fontSize: 12 }
    },
    series: [{
      type: 'pie',
      radius: ['52%', '78%'],
      center: ['38%', '52%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      data: slices
    }]
  }
}

function buildOption(): echarts.EChartsCoreOption {
  if (props.type === 'donut') return buildDonutOption()
  return buildAxisOption()
}

function init() {
  if (!el.value || chart) return
  chart = echarts.init(el.value)
  chart.setOption(buildOption())
}

watch(
  () => [props.rows, props.series, props.type, props.xField, props.yField, props.title],
  () => chart?.setOption(buildOption(), true),
  { deep: true }
)

useResizeObserver(el, () => chart?.resize())

onMounted(init)
onBeforeUnmount(() => { chart?.dispose(); chart = null })
</script>

<template>
  <div ref="el" style="width: 100%; height: 300px;" />
</template>
