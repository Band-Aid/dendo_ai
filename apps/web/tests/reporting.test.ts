import { inferChartConfig } from '../composables/useChartInference.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateValues, buildChartOption, chartIssue, chartTypes, formatMetric, metricCards, numericValue, prepareChart } from '../utils/chartEngine.ts'
import { defaultChart, emptyReport, publicChart, renderReport, reportSources } from '../utils/report.ts'
import { safeMarkdown } from '../utils/safeMarkdown.ts'
import { reportSchema } from '../server/utils/reportSchema.ts'
import { aggregationChartKeys, chartPresentation, resultChart, summaryChart, summaryChartKeys } from '../utils/notebookCharts.ts'
import type { NotebookWithCells, ChartCellMeta } from '../types/notebook.ts'

const rows = [{ month: 'Jan', users: 120, team: 'A' }, { month: 'Feb', users: 150, team: 'A' }, { month: 'Jan', users: 80, team: 'B' }, { month: 'Feb', users: null, team: 'B' }]
const chart: ChartCellMeta = { chartType: 'bar', title: 'Adoption', xField: 'month', yField: 'users', rows }

test('missing, blank, boolean and non-finite values never turn into fabricated zeroes', () => {
  for (const value of [null, undefined, '', ' ', true, NaN, Infinity, 'NaN', [], {}]) assert.equal(numericValue(value), null)
  assert.equal(numericValue('0'), 0)
  assert.equal(aggregateValues([null, '']), null)
  assert.equal(aggregateValues([0, null]), 0)
})
test('duplicate categories use the selected aggregation; grouped series retain gaps', () => {
  assert.deepEqual(prepareChart(chart).series[0].data, [200, 150])
  assert.deepEqual(prepareChart({ ...chart, aggregation: 'average' }).series[0].data, [100, 150])
  assert.deepEqual(prepareChart({ ...chart, groupField: 'team' }).series.map(s => s.data), [[120, 150], [80, null]])
  assert.deepEqual(prepareChart({ ...chart, sort: 'ascending' }).categories, ['Feb', 'Jan'])
  const line = buildChartOption({ ...chart, chartType: 'line', groupField: 'team' })
  assert.equal(line.series[1].connectNulls, false)
  assert.equal(line.series[1].data[1], null)
})
test('category identity preserves sub-day observations and values with different types', () => {
  const data = [{ x: '2026-09-01T08:00:00Z', y: 3 }, { x: '2026-09-01T12:00:00Z', y: 8 }, { x: 1, y: 4 }, { x: '1', y: 5 }]
  assert.equal(prepareChart({ chartType: 'line', rows: data, xField: 'x', yField: 'y' }).categories.length, 4)
})
test('multiple measures and independent series align without assuming matching row order', () => {
  const multi = prepareChart({ ...chart, series: [{ name: 'A', rows: [{ x: 'one', y: 2 }, { x: 'two', y: 3 }], xField: 'x', yField: 'y' }, { name: 'B', rows: [{ x: 'two', y: 4 }], xField: 'x', yField: 'y' }] })
  assert.deepEqual(multi.series.map(s => s.data), [[2, 3], [null, 4]])
  assert.equal(prepareChart({ ...chart, yFields: ['users', 'month'] }).series.length, 2)
})
test('every advertised chart builds its intended series type', () => {
  const expected: Record<string, string> = { bar: 'bar', 'horizontal-bar': 'bar', 'stacked-bar': 'bar', line: 'line', area: 'line', pie: 'pie', donut: 'pie', scatter: 'scatter', heatmap: 'heatmap', funnel: 'funnel' }
  for (const { value } of chartTypes) {
    if (value === 'metric') { assert.equal(metricCards(chart)[0].value, 350); continue }
    assert.equal(buildChartOption({ ...chart, chartType: value }).series[0].type, expected[value])
  }
  assert.equal(buildChartOption({ ...chart, chartType: 'horizontal-bar' }).yAxis.type, 'category')
  assert.equal(buildChartOption({ ...chart, chartType: 'stacked-bar' }).series[0].stack, 'total')
  assert.ok(buildChartOption({ ...chart, chartType: 'area' }).series[0].areaStyle)
  assert.equal(buildChartOption({ ...chart, chartType: 'funnel' }).series[0].sort, 'none')
})
test('invalid scatter and proportions show an actionable state; KPI aggregation and formats are explicit', () => {
  assert.match(chartIssue({ ...chart, chartType: 'scatter' })!, /numeric fields/)
  assert.match(chartIssue({ ...chart, chartType: 'donut', rows: [{ month: 'A', users: -1 }] })!, /non-negative/)
  assert.match(chartIssue({ ...chart, chartType: 'pie', rows: [{ month: 'A', users: 0 }] })!, /positive/)
  assert.equal(metricCards({ ...chart, aggregation: 'last' })[0].value, 80)
  assert.equal(metricCards({ ...chart, aggregation: 'average' })[0].value, 350 / 3)
  assert.equal(formatMetric(.25, { numberFormat: 'percent' }), '25%')
  assert.equal(formatMetric(1250, { numberFormat: 'compact' }), '1.3K')
})
const notebook = { id: 'nb', title: 'Report', cells: [
  { id: 'query', cell_type: 'query', content: 'SECRET DSL', position: 0, updated_at: '2026-09-01' },
  { id: 'note', cell_type: 'note', content: 'A finding', position: 1, updated_at: '2026-09-01', meta_json: {} },
  { id: 'chart', cell_type: 'chart', position: 2, updated_at: '2026-09-02', meta_json: { ...chart, dsl: 'SECRET DSL', rows: rows.map(r => ({ ...r, private: 'PRIVATE DATA' })) } },
  { id: 'result', cell_type: 'result', position: 3, updated_at: '2026-09-02', meta_json: { rows: [{ label: 'A', value: 3, private: 'PRIVATE DATA' }], columns: ['label', 'value', 'private'], columnOrder: ['value', 'label'], title: 'Evidence', runAt: '2026-09-01' } },
  { id: 'question', cell_type: 'question', content: 'Why?', position: 4, updated_at: '2026-09-02', meta_json: { answer: 'Because…', aggregations: [{ rows: [{ x: 'a', y: 5 }], columns: ['x', 'y'], dsl: 'SECRET DSL' }], summaryCharts: [{ title: 'Summary', chartType: 'bar', series: [{ name: 'A', points: [{ label: 'A', value: 5 }] }] }] } }
] } as unknown as NotebookWithCells

test('notebook sources include question findings, tables and summary charts but exclude query cells', () => {
  const sources = reportSources(notebook)
  assert.deepEqual(sources.map(s => s.key), ['note', 'chart', 'result', 'question:answer', 'question:table:0', 'question:chart:0'])
  assert.deepEqual(sources.find(s => s.key === 'result')?.columns, ['value', 'label', 'private'])
  assert.equal(defaultChart([{ total: 12 }], ['total']).chartType, 'metric')
})
test('published projection contains only selected blocks, plotted fields, visible columns and no DSL', () => {
  const config = emptyReport('Review')
  config.blocks = [
    { id: 'a', sourceKey: 'chart', kind: 'chart', title: 'Chart', width: 'half' },
    { id: 'b', sourceKey: 'result', kind: 'table', title: 'Table', width: 'half', columns: ['value', 'label'] }
  ]
  const report = renderReport(config, reportSources(notebook))
  const json = JSON.stringify(report)
  assert.ok(!json.includes('SECRET DSL'))
  assert.ok(!json.includes('PRIVATE DATA'))
  assert.ok(!json.includes('Because'))
  assert.ok(!json.includes('sourceKey'))
  assert.deepEqual(report.blocks[1].columns, ['value', 'label'])
  assert.equal(report.blocks[1].sourceUpdatedAt, '2026-09-01')
  assert.deepEqual(Object.keys(report.blocks[0].chart!.rows![0]), ['month', 'users'])
})
test('multi-series snapshots strip DSL and unused fields; source deletion is visible', () => {
  const safe = publicChart({ ...chart, series: [{ name: 'A', dsl: 'SECRET', sourceResultCellId: 'private-id', rows: [{ label: 'A', value: 4, hidden: 'SECRET' }], xField: 'label', yField: 'value' }] })
  assert.ok(!JSON.stringify(safe).includes('SECRET'))
  assert.ok(!JSON.stringify(safe).includes('private-id'))
  const config = emptyReport('Review'); config.blocks = [{ id: 'a', kind: 'text', sourceKey: 'deleted', title: 'Missing', width: 'full' }]
  assert.equal(renderReport(config, []).blocks[0].missing, true)
})
test('report schema rejects invalid settings, duplicate block IDs and data injection into chart options', () => {
  const config = emptyReport('Review'); config.blocks = [{ id: 'a', kind: 'chart', title: 'Chart', width: 'half', chart: { ...chart } }]
  const parsed = reportSchema.parse(config)
  assert.equal(parsed.blocks[0].chart?.chartType, 'bar')
  assert.equal((parsed.blocks[0].chart as any).rows, undefined)
  assert.equal(reportSchema.safeParse({ ...config, title: ' ' }).success, false)
  assert.equal(reportSchema.safeParse({ ...config, blocks: [config.blocks[0], config.blocks[0]] }).success, false)
})
test('report markdown preserves formatting while neutralizing executable HTML, links and images', () => {
  const html = safeMarkdown('**Decision**\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n[x](jav&#x61;script:evil)\n\n![x](https://tracker.example/x)\n\n[Reference](https://example.com)')
  assert.ok(html.includes('<strong>Decision</strong>'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(!html.includes('href="jav&#'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
})

test('selected measures exclude unused legacy value fields from the shared payload', () => {
  const chart = publicChart({ chartType: 'bar', title: '', xField: 'x', yField: 'private', yFields: ['shown'], rows: [{ x: 'A', shown: 2, private: 'SECRET' }] })
  assert.ok(!JSON.stringify(chart.rows).includes('SECRET'))
})

test('source schema changes surface missing chart fields and removed table columns', () => {
  assert.match(chartIssue({ ...chart, xField: 'removed' })!, /available category/)
  assert.match(chartIssue({ ...chart, yFields: ['users', 'removed'] })!, /value field/)
  assert.match(chartIssue({ ...chart, groupField: 'removed' })!, /grouping field/)
  const config = emptyReport('Review'); config.blocks = [{ id: 'a', kind: 'table', sourceKey: 'result', title: 'Table', width: 'full', columns: ['removed'] }]
  assert.match(renderReport(config, reportSources(notebook)).blocks[0].issue!, /no longer in the source/)
  config.blocks = [{ id: 'a', kind: 'chart', sourceKey: 'chart', title: 'Chart', width: 'full', chart: { xField: 'removed' } }]
  assert.match(renderReport(config, reportSources(notebook)).blocks[0].issue!, /available category/)
})


test('chart inference handles single KPI values, numeric strings, sparse first rows and numeric relationships', () => {
  assert.equal(inferChartConfig([{ total: 12 }], ['total'])?.type, 'metric')
  assert.equal(inferChartConfig([{ name: 'A', count: null }, { name: 'B', count: '5' }], ['name', 'count'])?.type, 'bar')
  assert.equal(inferChartConfig([{ x: 1, y: 2 }, { x: 3, y: 4 }], ['x', 'y'])?.type, 'scatter')
  assert.equal(inferChartConfig([{ day: '2026-09-01', total: '5' }], ['day', 'total'])?.type, 'line')
  assert.equal(inferChartConfig([{ label: 'A' }], ['label']), null)
})

test('vector tooltips and data labels honor number formatting', () => {
  const scatter = buildChartOption({ ...chart, chartType: 'scatter', numberFormat: 'compact' })
  assert.deepEqual(scatter.tooltip.valueFormatter([1200, 3400]), ['1.2K', '3.4K'])
  assert.equal(scatter.xAxis.nameLocation, 'middle')
  const pie = buildChartOption({ ...chart, chartType: 'pie', numberFormat: 'percent', showLabels: true })
  assert.equal(pie.series[0].label.formatter({ name: 'A', value: .25 }), 'A: 25%')
  const heatmap = buildChartOption({ ...chart, chartType: 'heatmap', numberFormat: 'percent', showLabels: true })
  assert.equal(heatmap.series[0].label.formatter({ value: [0, 0, .5] }), '50%')
})

test('legacy embedded charts accept saved presentation without freezing refreshed data', () => {
  assert.equal(resultChart(rows, ['month', 'users', 'team'])?.chartType, 'bar')
  const settings = chartPresentation({ ...chart, chartType: 'area', target: undefined, showLabels: false, displayMode: 'chart', dsl: 'private' })
  assert.ok(!('rows' in settings) && !('dsl' in settings))
  assert.ok(Object.hasOwn(settings, 'target'), 'clearing an optional setting must replace its old value')
  const freshRows = [{ month: 'Mar', users: 900 }]
  const configured = resultChart(freshRows, ['month', 'users'], settings)!
  assert.equal(configured.chartType, 'area')
  assert.equal(configured.showLabels, false)
  assert.deepEqual(prepareChart(configured).series[0].data, [900])
  assert.equal(resultChart([], ['month', 'users'], settings)?.chartType, 'area')
  assert.equal(resultChart([{ label: 'A' }], ['label']), null)
})

test('question settings follow the source across refreshed values and reordered aggregations', () => {
  const a = { dsl: 'query A', rows, columns: ['month', 'users'] }
  const b = { ...a, dsl: 'query B' }
  const keys = aggregationChartKeys([a, b])
  assert.deepEqual(aggregationChartKeys([{ ...b, rows: [] }, { ...a, explanation: 'New narrative' }]), [keys[1], keys[0]])
  assert.notEqual(aggregationChartKeys([a, a])[0], aggregationChartKeys([a, a])[1])
  const spec = { title: 'Summary', chartType: 'bar' as const, series: [{ name: 'A', points: [{ label: 'Jan', value: 3 }] }] }
  const refreshed = { ...spec, series: [{ name: 'A', points: [{ label: 'Feb', value: 20 }] }] }
  assert.deepEqual(summaryChartKeys([spec]), summaryChartKeys([refreshed]))
  const configured = summaryChart(refreshed, { chartType: 'donut', palette: 'forest' })
  assert.equal(configured.chartType, 'donut')
  assert.deepEqual(prepareChart(configured).series[0].data, [20])
})

test('reports inherit embedded chart choices while retaining independent report overrides', () => {
  const copy = structuredClone(notebook)
  const result = copy.cells.find(c => c.cell_type === 'result')!
  if (result.cell_type !== 'result') throw new Error('Missing fixture')
  result.meta_json.chartConfig = { chartType: 'donut', displayMode: 'chart', numberFormat: 'compact' }
  const question = copy.cells.find(c => c.cell_type === 'question')!
  if (question.cell_type !== 'question') throw new Error('Missing fixture')
  question.meta_json.chartConfigs = {
    [aggregationChartKeys(question.meta_json.aggregations!)[0]]: { chartType: 'horizontal-bar', displayMode: 'chart' },
    [summaryChartKeys(question.meta_json.summaryCharts!)[0]]: { chartType: 'area', palette: 'ocean' }
  }
  const sources = reportSources(copy)
  assert.equal(sources.find(s => s.key === 'result')?.kind, 'chart')
  assert.equal(sources.find(s => s.key === 'result')?.chart?.chartType, 'donut')
  assert.equal(sources.find(s => s.key === 'question:table:0')?.chart?.chartType, 'horizontal-bar')
  assert.equal(sources.find(s => s.key === 'question:chart:0')?.chart?.palette, 'ocean')
  const config = emptyReport('Review')
  config.blocks = [{ id: 'a', sourceKey: 'result', kind: 'chart', title: 'Result', width: 'full', chart: { chartType: 'metric' } }]
  assert.equal(renderReport(config, sources).blocks[0].chart?.chartType, 'metric')
  assert.equal(result.meta_json.chartConfig.chartType, 'donut')
})
