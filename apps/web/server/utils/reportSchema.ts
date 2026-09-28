import { z } from 'zod'
export const chartOptionsSchema = z.object({
  chartType: z.enum(['line', 'area', 'bar', 'horizontal-bar', 'stacked-bar', 'pie', 'donut', 'scatter', 'heatmap', 'funnel', 'metric']).optional(),
  xField: z.string().max(500).optional(), yField: z.string().max(500).optional(),
  yFields: z.array(z.string().max(500)).max(30).optional(), groupField: z.string().max(500).optional(),
  aggregation: z.enum(['sum', 'average', 'min', 'max', 'last']).optional(),
  numberFormat: z.enum(['number', 'compact', 'percent', 'currency']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), decimals: z.number().int().min(0).max(6).optional(),
  xAxisLabel: z.string().max(300).optional(), yAxisLabel: z.string().max(300).optional(),
  showLegend: z.boolean().optional(), showLabels: z.boolean().optional(),
  sort: z.enum(['source', 'ascending', 'descending']).optional(), palette: z.enum(['editorial', 'ocean', 'forest']).optional(),
  target: z.number().finite().optional()
})
export const reportSchema = z.object({
  version: z.literal(1), title: z.string().trim().min(1).max(200), subtitle: z.string().max(1000),
  audience: z.string().max(200), author: z.string().max(200), period: z.string().max(200),
  summary: z.string().max(30000), nextSteps: z.string().max(30000),
  template: z.enum(['brief', 'readout', 'dashboard']),
  blocks: z.array(z.object({
    id: z.string().min(1).max(100), kind: z.enum(['heading', 'text', 'chart', 'table']),
    sourceKey: z.string().max(200).optional(), title: z.string().max(1000), caption: z.string().max(3000).optional(),
    width: z.enum(['full', 'half', 'third']), content: z.string().max(50000).optional(),
    chart: chartOptionsSchema.optional(), columns: z.array(z.string().max(500)).max(200).optional()
  })).max(200).refine(blocks => new Set(blocks.map(b => b.id)).size === blocks.length, 'Block IDs must be unique')
})
export const saveReportSchema = z.object({ config: reportSchema, expectedUpdatedAt: z.string().nullable() })
