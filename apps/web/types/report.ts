import type { ChartCellMeta } from './notebook'

export interface ReportBlock {
  id: string
  kind: 'heading' | 'text' | 'chart' | 'table'
  sourceKey?: string
  title: string
  caption?: string
  width: 'full' | 'half' | 'third'
  content?: string
  chart?: Partial<ChartCellMeta>
  columns?: string[]
}
export interface ReportConfig {
  version: 1
  title: string
  subtitle: string
  audience: string
  author: string
  period: string
  summary: string
  nextSteps: string
  template: 'brief' | 'readout' | 'dashboard'
  blocks: ReportBlock[]
}
export interface ReportSource {
  key: string
  kind: 'text' | 'chart' | 'table'
  title: string
  content?: string
  chart?: ChartCellMeta
  rows?: Record<string, unknown>[]
  columns?: string[]
  updatedAt: string
}
export interface RenderedReportBlock extends ReportBlock {
  rows?: Record<string, unknown>[]
  sourceTitle?: string
  sourceUpdatedAt?: string
  missing?: boolean
  issue?: string
}
export interface ReportDocument extends Omit<ReportConfig, 'blocks'> {
  blocks: RenderedReportBlock[]
  publishedAt?: string
}
export interface ReportState {
  config: ReportConfig | null
  updatedAt: string | null
  publishedAt: string | null
  shareToken: string | null
}
