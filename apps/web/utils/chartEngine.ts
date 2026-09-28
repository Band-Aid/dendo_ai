import { formatDateValue, DATE_COLUMN_NAME_RE } from '../composables/useDateFormat.ts'
import type { ChartCellMeta, ChartOptions, ChartSeries, ChartType } from '../types/notebook'

export const chartTypes: { value: ChartType; label: string }[] = [
  { value: 'bar', label: 'Column' }, { value: 'horizontal-bar', label: 'Horizontal bar' },
  { value: 'stacked-bar', label: 'Stacked column' }, { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' }, { value: 'donut', label: 'Donut' },
  { value: 'pie', label: 'Pie' }, { value: 'scatter', label: 'Scatter' },
  { value: 'heatmap', label: 'Heatmap' }, { value: 'funnel', label: 'Funnel' },
  { value: 'metric', label: 'KPI card' }
]

export const palettes = {
  editorial: ['#A8412B', '#376D89', '#C3943A', '#3D7159', '#786198', '#6B7981', '#D98466', '#9CA84D'],
  ocean: ['#245D80', '#3695AD', '#755EAB', '#D09A3F', '#55746A', '#B3637A'],
  forest: ['#32664C', '#8B9D46', '#C79C50', '#458C8D', '#8B637B', '#A75234']
}
export type ChartInput = Partial<ChartCellMeta> & { chartType: ChartType }

export function numericValue(value: unknown): number | null {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function aggregateValues(values: unknown[], method: ChartOptions['aggregation'] = 'sum'): number | null {
  const numbers = values.map(numericValue).filter((n): n is number => n !== null)
  if (!numbers.length) return null
  if (method === 'last') return numbers[numbers.length - 1]
  if (method === 'min') return numbers.reduce((a, b) => Math.min(a, b))
  if (method === 'max') return numbers.reduce((a, b) => Math.max(a, b))
  const sum = numbers.reduce((a, b) => a + b, 0)
  return method === 'average' ? sum / numbers.length : sum
}

export function formatMetric(value: unknown, config: ChartOptions = {}): string {
  const number = numericValue(value)
  if (number === null) return '—'
  const digits = Math.min(6, Math.max(0, config.decimals ?? 1))
  const options: Intl.NumberFormatOptions = { maximumFractionDigits: digits }
  if (config.numberFormat === 'compact') options.notation = 'compact'
  if (config.numberFormat === 'percent') options.style = 'percent'
  if (config.numberFormat === 'currency') {
    options.style = 'currency'
    options.currency = /^[A-Z]{3}$/.test(config.currency || '') ? config.currency : 'USD'
  }
  return new Intl.NumberFormat('en-US', options).format(number)
}

export function chartColumns(input: Partial<ChartCellMeta>): string[] {
  return [...new Set([...(input.columns || []), ...(input.rows || []).flatMap(Object.keys), ...(input.series || []).flatMap(s => s.rows.flatMap(Object.keys))])]
}

export function normalizeSeries(input: ChartInput): (ChartSeries & { xField: string; yField: string })[] {
  if (input.series?.length) return input.series.map((s, i) => ({ ...s, name: s.name || `Series ${i + 1}`, xField: s.xField ?? input.xField ?? '', yField: s.yField ?? input.yField ?? '' }))
  const fields = input.yFields?.length ? input.yFields : [input.yField || '']
  const rows = input.rows || []
  const groupField = input.groupField
  const groups = groupField ? [...new Set(rows.map(r => String(r[groupField] ?? '(missing)')))] : ['']
  return groups.flatMap(group => fields.map(field => ({
    name: [group, fields.length > 1 || !group ? field : ''].filter(Boolean).join(' · ') || 'Value',
    rows: groupField ? rows.filter(r => String(r[groupField] ?? '(missing)') === group) : rows,
    xField: input.xField || '', yField: field
  })))
}

// Category identity uses the raw value. Formatting a timestamp to a short date
// before grouping silently merges separate observations within the same day.
function categoryKey(value: unknown): string { return JSON.stringify([typeof value, value ?? null]) }
function categoryLabel(value: unknown): string { return value == null ? '(missing)' : String(value) }

export function prepareChart(input: ChartInput) {
  const source = normalizeSeries(input)
  const categories = new Map<string, string>()
  const series = source.map(s => {
    const groups = new Map<string, unknown[]>()
    for (const row of s.rows) {
      const key = categoryKey(row[s.xField])
      categories.set(key, categoryLabel(row[s.xField]))
      const values = groups.get(key) || []
      values.push(row[s.yField])
      groups.set(key, values)
    }
    return { name: s.name, values: new Map([...groups].map(([key, values]) => [key, aggregateValues(values, input.aggregation)])) }
  })
  let keys = [...categories.keys()]
  if (input.sort && input.sort !== 'source') {
    const total = (key: string) => aggregateValues(series.map(s => s.values.get(key))) ?? -Infinity
    keys.sort((a, b) => input.sort === 'ascending' ? total(a) - total(b) : total(b) - total(a))
  }
  return { categories: keys.map(key => categories.get(key)!), series: series.map(s => ({ name: s.name, data: keys.map(key => s.values.get(key) ?? null) })), source }
}

export function metricCards(input: ChartInput) {
  return normalizeSeries(input).map(s => ({ name: s.name, value: aggregateValues(s.rows.map(r => r[s.yField]), input.aggregation) }))
}

export function chartIssue(input: ChartInput): string | null {
  const source = normalizeSeries(input)
  if (!source.some(s => s.rows.length)) return 'No data yet. Run the source query to populate this visualization.'
  if (input.groupField && !input.series?.length && !(input.rows || []).some(r => Object.hasOwn(r, input.groupField!))) return 'The grouping field is no longer in the source. Choose an available field.'
  for (const s of source) {
    if (s.rows.length && !s.rows.some(r => Object.hasOwn(r, s.yField))) return 'A value field is no longer in the source. Choose an available value field.'
    if (input.chartType !== 'metric' && s.rows.length && (!s.xField || !s.rows.some(r => Object.hasOwn(r, s.xField)))) return 'Choose an available category or X axis field.'
  }
  if (!source.some(s => s.rows.some(r => numericValue(r[s.yField]) !== null))) return 'Choose a numeric value field to draw this visualization.'
  if (input.chartType === 'scatter' && !source.some(s => s.rows.some(r => numericValue(r[s.xField]) !== null && numericValue(r[s.yField]) !== null))) return 'Scatter plots need numeric fields on both axes.'
  if (['pie', 'donut', 'funnel'].includes(input.chartType) && source.some(s => s.rows.some(r => (numericValue(r[s.yField]) ?? 0) < 0))) return 'This chart needs non-negative values. Use a column or line chart for signed values.'
  if (['pie', 'donut'].includes(input.chartType) && !source.some(s => s.rows.some(r => (numericValue(r[s.yField]) ?? 0) > 0))) return 'No positive values to show as proportions.'
  return null
}

/** Shared by notebook charts and reports. No data coercion to zero or implicit interpolation. */
export function buildChartOption(input: ChartInput): Record<string, any> {
  const prepared = prepareChart(input)
  const { categories, series, source } = prepared
  const palette = palettes[input.palette || 'editorial'] || palettes.editorial
  const base = {
    animation: false,
    color: palette,
    textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: '#3C3A35' },
    aria: { enabled: true, decal: { show: false } },
    title: input.title ? { text: input.title, textStyle: { fontSize: 14 } } : undefined,
    // Rich text avoids interpolating source values into tooltip HTML.
    tooltip: { trigger: 'axis', renderMode: 'richText', valueFormatter: (value: unknown) => Array.isArray(value) ? value.map(v => formatMetric(v, input)) : formatMetric(value, input) },
    legend: { show: input.showLegend !== false && series.length > 1, type: 'scroll', bottom: 0 },
    grid: { left: input.yAxisLabel ? 50 : 16, right: 24, top: input.title ? 42 : 20, bottom: input.xAxisLabel ? 72 : 48, containLabel: true }
  }
  if (['pie', 'donut', 'funnel'].includes(input.chartType)) {
    const data = source.length > 1
      ? metricCards(input).filter(s => s.value !== null)
      : categories.map((name, i) => ({ name, value: series[0]?.data[i] })).filter(s => s.value != null)
    return {
      ...base, tooltip: { ...base.tooltip, trigger: 'item' },
      legend: { ...base.legend, show: input.showLegend !== false },
      series: [{
        type: input.chartType === 'funnel' ? 'funnel' : 'pie',
        radius: input.chartType === 'donut' ? ['48%', '72%'] : '72%',
        center: ['50%', '44%'], top: 18, bottom: 45, left: '15%', width: '70%',
        sort: 'none', minSize: '0%', gap: 3,
        label: { show: input.showLabels === true, formatter: (p: any) => `${p.name}: ${formatMetric(p.value, input)}` },
        data
      }]
    }
  }
  if (input.chartType === 'scatter') return {
    ...base, tooltip: { ...base.tooltip, trigger: 'item' },
    grid: { ...base.grid, left: 55, bottom: 72 },
    xAxis: { type: 'value', name: input.xAxisLabel || input.xField, nameLocation: 'middle', nameGap: 30 },
    yAxis: { type: 'value', name: input.yAxisLabel || input.yField, nameLocation: 'middle', nameGap: 40, axisLabel: { formatter: (n: number) => formatMetric(n, input) } },
    series: source.map(s => ({ name: s.name, type: 'scatter', symbolSize: 10, label: { show: input.showLabels === true, position: 'top', formatter: (p: any) => formatMetric(p.value[1], input) }, data: s.rows.map(r => [numericValue(r[s.xField]), numericValue(r[s.yField])]).filter(([x, y]) => x !== null && y !== null) }))
  }
  if (input.chartType === 'heatmap') {
    const values = series.flatMap(s => s.data).filter((v): v is number => v !== null)
    const min = values.length ? values.reduce((a, b) => Math.min(a, b)) : 0
    const max = values.length ? values.reduce((a, b) => Math.max(a, b)) : 1
    return {
      ...base, legend: { show: false }, tooltip: { trigger: 'item', renderMode: 'richText' },
      grid: { ...base.grid, bottom: 70 },
      xAxis: { type: 'category', data: categories, splitArea: { show: true } },
      yAxis: { type: 'category', data: series.map(s => s.name), splitArea: { show: true } },
      visualMap: { min, max: min === max ? max + 1 : max, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#F5EFE4', palette[0]] } },
      series: [{ type: 'heatmap', label: { show: input.showLabels === true, formatter: (p: any) => formatMetric(p.value[2], input) }, data: series.flatMap((s, y) => s.data.flatMap((value, x) => value === null ? [] : [[x, y, value]])) }]
    }
  }
  const horizontal = input.chartType === 'horizontal-bar'
  const line = ['line', 'area'].includes(input.chartType)
  const axisFormatter = (value: string) => DATE_COLUMN_NAME_RE.test(source[0]?.xField || '') || /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDateValue(value) : value
  const categoryAxis = { type: 'category', data: categories, name: input.xAxisLabel || '', nameLocation: 'middle', nameGap: 30, axisTick: { show: false }, axisLabel: { formatter: axisFormatter, hideOverlap: true, width: horizontal ? 140 : 100, overflow: 'truncate' } }
  const valueAxis = { type: 'value', name: input.yAxisLabel || '', nameLocation: 'middle', nameGap: 40, axisLabel: { formatter: (n: number) => formatMetric(n, input) }, splitLine: { lineStyle: { color: '#EFEADB' } } }
  return {
    ...base,
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: series.map(s => ({
      ...s, type: line ? 'line' : 'bar',
      stack: input.chartType === 'stacked-bar' ? 'total' : undefined,
      areaStyle: input.chartType === 'area' ? { opacity: 0.15 } : undefined,
      smooth: false, connectNulls: false, symbolSize: 6, barMaxWidth: 48,
      label: { show: input.showLabels === true, position: horizontal ? 'right' : 'top', formatter: (p: any) => formatMetric(p.value, input) },
      emphasis: { focus: 'series' }
    }))
  }
}
