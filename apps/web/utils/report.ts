import type { ChartCellMeta, NotebookWithCells } from '../types/notebook'
import type { ReportBlock, ReportConfig, ReportDocument, ReportSource } from '../types/report'
import { normalizeSeries, numericValue, chartIssue } from './chartEngine.ts'
import { aggregationChartKeys, resultChart, summaryChart, summaryChartKeys } from './notebookCharts.ts'

export function defaultChart(rows: Record<string, unknown>[], columns: string[]): ChartCellMeta {
  const numeric = columns.filter(c => rows.some(r => numericValue(r[c]) !== null))
  const time = columns.find(c => /date|day|week|month|time|period/i.test(c))
  const x = time || columns.find(c => !numeric.includes(c)) || columns[0] || ''
  const y = numeric.find(c => c !== x) || numeric[0] || ''
  return { chartType: time ? 'line' : columns.length === 1 ? 'metric' : 'bar', title: '', xField: x, yField: y, rows, columns }
}

export function reportSources(notebook: NotebookWithCells): ReportSource[] {
  const sources: ReportSource[] = []
  for (const cell of [...notebook.cells].sort((a, b) => a.position - b.position)) {
    const base = { updatedAt: cell.updated_at }
    if (cell.cell_type === 'note' || cell.cell_type === 'insight' || cell.cell_type === 'agent_message') {
      sources.push({ ...base, key: cell.id, kind: 'text', title: cell.content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 120) || 'Note', content: cell.content })
    } else if (cell.cell_type === 'chart') {
      sources.push({ ...base, key: cell.id, kind: 'chart', title: cell.meta_json.title || 'Chart', chart: cell.meta_json })
    } else if (cell.cell_type === 'result') {
      const m = cell.meta_json
      const columns = [...new Set([...(m.columnOrder || []).filter(c => m.columns.includes(c)), ...m.columns])]
      sources.push({ ...base, updatedAt: m.runAt || cell.updated_at, key: cell.id, kind: m.chartConfig?.displayMode === 'chart' ? 'chart' : 'table', title: m.title || 'Results', rows: m.rows, columns, chart: resultChart(m.rows, m.columns, m.chartConfig) || defaultChart(m.rows, columns) })
    } else if (cell.cell_type === 'question') {
      const m = cell.meta_json
      const updatedAt = m.lastRunAt || cell.updated_at
      if (m.answer) sources.push({ key: `${cell.id}:answer`, kind: 'text', title: cell.content, content: m.answer, updatedAt })
      const aggKeys = aggregationChartKeys(m.aggregations || [])
      const summaryKeys = summaryChartKeys(m.summaryCharts || [])
      for (const [i, a] of (m.aggregations || []).entries()) {
        const settings = m.chartConfigs?.[aggKeys[i]]
        sources.push({ key: `${cell.id}:table:${i}`, kind: settings?.displayMode === 'chart' ? 'chart' : 'table', title: a.explanation || cell.content, rows: a.rows, columns: a.columns, chart: resultChart(a.rows, a.columns, settings) || defaultChart(a.rows, a.columns), updatedAt })
      }
      for (const [i, c] of (m.summaryCharts || []).entries()) sources.push({
        key: `${cell.id}:chart:${i}`, kind: 'chart', title: c.title, updatedAt,
        chart: summaryChart(c, m.chartConfigs?.[summaryKeys[i]])
      })
    }
  }
  return sources
}

export function emptyReport(title: string): ReportConfig {
  return { version: 1, title, subtitle: '', audience: '', author: '', period: '', summary: '', nextSteps: '', template: 'brief', blocks: [] }
}

/** Share only fields used by a visualization; never serialize the original cell metadata or DSL. */
export function publicChart(input: ChartCellMeta): ChartCellMeta {
  const options = Object.fromEntries(['chartType', 'title', 'xField', 'yField', 'yFields', 'groupField', 'aggregation', 'numberFormat', 'currency', 'decimals', 'xAxisLabel', 'yAxisLabel', 'showLegend', 'showLabels', 'sort', 'palette', 'target'].filter(k => (input as any)[k] !== undefined).map(k => [k, (input as any)[k]])) as unknown as ChartCellMeta
  if (input.series?.length) {
    options.series = normalizeSeries(input).map(s => ({ name: s.name, xField: s.xField, yField: s.yField,
      rows: s.rows.map(r => Object.fromEntries([...new Set([s.xField, s.yField])].filter(Boolean).map(k => [k, r[k] ?? null]))) }))
  } else {
    const fields = [...new Set([input.xField, ...(input.yFields?.length ? input.yFields : [input.yField]), input.groupField].filter((k): k is string => !!k))]
    options.rows = (input.rows || []).map(r => Object.fromEntries(fields.map(k => [k, r[k] ?? null])))
    options.columns = fields
  }
  return options
}

export function renderReport(config: ReportConfig, sources: ReportSource[]): ReportDocument {
  const byKey = new Map(sources.map(s => [s.key, s]))
  return {
    ...config,
    blocks: config.blocks.map(block => {
      const source = block.sourceKey ? byKey.get(block.sourceKey) : undefined
      const base = { id: block.id, kind: block.kind, title: block.title, caption: block.caption, width: block.width,
        sourceTitle: source?.title, sourceUpdatedAt: source?.updatedAt,
        missing: !!block.sourceKey && !source }
      if (block.kind === 'heading') return base
      if (block.kind === 'text') return { ...base, content: block.content ?? source?.content ?? '' }
      if (block.kind === 'chart') {
        const input: ChartCellMeta = { chartType: 'bar', title: '', ...source?.chart, ...block.chart }
        return { ...base, issue: chartIssue(input) || undefined, chart: publicChart(input) }
      }
      const chart = source?.chart
      const rows: Record<string, unknown>[] = source?.rows || chart?.rows || (chart?.series || []).flatMap(s => s.rows.map(r => ({ series: s.name, ...r })))
      const available = source?.columns || [...new Set(rows.flatMap(Object.keys))]
      const columns = block.columns?.length ? block.columns.filter(c => available.includes(c)) : available
      const issue = block.columns?.some(c => !available.includes(c)) ? 'Selected columns are no longer in the source. Choose available columns before sharing.' : undefined
      return { ...base, issue, columns, rows: rows.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null]))) }
    })
  }
}

export function sourceBlock(source: ReportSource, id: string): ReportBlock {
  return { id, sourceKey: source.key, kind: source.kind, title: source.title, width: source.kind === 'chart' ? 'half' : 'full' }
}
