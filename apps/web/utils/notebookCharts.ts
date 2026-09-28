import type { ChartCellMeta, ChatAggregation, ChatSummaryChart, EmbeddedChartConfig } from '../types/notebook'
import { inferChartConfig } from '../composables/useChartInference.ts'

/** Never save a copy of query results inside presentation settings. Keep
 * explicitly undefined values so clearing a setting removes the old value. */
export function chartPresentation(input: Partial<ChartCellMeta> & EmbeddedChartConfig): EmbeddedChartConfig {
  const keys = ['chartType', 'xField', 'yField', 'yFields', 'groupField', 'aggregation', 'numberFormat', 'currency', 'decimals', 'xAxisLabel', 'yAxisLabel', 'showLegend', 'showLabels', 'sort', 'palette', 'target', 'displayMode']
  return Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, (input as any)[key]]))
}

export function resultChart(rows: Record<string, unknown>[], columns: string[], config: EmbeddedChartConfig = {}): ChartCellMeta | null {
  const inferred = inferChartConfig(rows, columns)
  if (!inferred && !config.chartType) return null
  return { chartType: inferred?.type || 'bar', title: inferred?.title || '', xField: inferred?.xField, yField: inferred?.yField,
    ...chartPresentation(config), rows, columns }
}

export function summaryChart(spec: ChatSummaryChart, config: EmbeddedChartConfig = {}): ChartCellMeta {
  return { title: spec.title, chartType: spec.chartType, xField: 'label', yField: 'value', xAxisLabel: spec.xAxisLabel, yAxisLabel: spec.yAxisLabel,
    ...chartPresentation(config),
    series: spec.series.map(s => ({ name: s.name, xField: 'label', yField: 'value', rows: s.points.map(p => ({ label: p.label, value: p.value })) })) }
}

function sourceKeys(kind: string, signatures: string[]): string[] {
  const seen = new Map<string, number>()
  return signatures.map(signature => {
    const occurrence = seen.get(signature) || 0
    seen.set(signature, occurrence + 1)
    return JSON.stringify([kind, signature, occurrence])
  })
}

/** Identify sources by their definition, not row values or list position, so
 * fresh/reordered results retain the right settings. Duplicate definitions
 * are distinguished by occurrence within that definition. */
export function aggregationChartKeys(aggregations: ChatAggregation[]): string[] {
  return sourceKeys('aggregation', aggregations.map(a => a.dsl?.trim() || JSON.stringify([a.explanation || '', a.columns])))
}

export function summaryChartKeys(charts: ChatSummaryChart[]): string[] {
  return sourceKeys('summary', charts.map(c => JSON.stringify([c.title, c.series.map(s => s.name).sort()])))
}
