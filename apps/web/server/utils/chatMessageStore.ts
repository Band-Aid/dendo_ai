import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client'
import type { ChartType } from '~/types/notebook'

export interface ChatAggregation {
  dsl: string
  rows: Record<string, unknown>[]
  columns: string[]
  explanation?: string
}

export interface ChatSummaryChartPoint {
  label: string
  value: number
}
export interface ChatSummaryChartSeries {
  name: string
  points: ChatSummaryChartPoint[]
}
/**
 * Agent-built chart spec — the comparison key and metric are already chosen by
 * the model (via the `build_summary_chart` tool), so we don't have to infer
 * commensurability from raw query output.
 */
export interface ChatSummaryChart {
  title: string
  chartType: ChartType
  xAxisLabel?: string
  yAxisLabel?: string
  series: ChatSummaryChartSeries[]
  explanation?: string
}

export interface ChatMessage {
  id: string
  notebook_id: string
  role: 'user' | 'assistant'
  content: string
  dsl: string | null
  aggregations: ChatAggregation[]
  summary_charts: ChatSummaryChart[]
  referenced_cell_ids: string[]
  created_at: string
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function rowToMessage(row: any): ChatMessage {
  return {
    id: row.id,
    notebook_id: row.notebook_id,
    role: row.role,
    content: row.content ?? '',
    dsl: row.dsl ?? null,
    aggregations: parseJson<ChatAggregation[]>(row.aggregations_json, []),
    summary_charts: parseJson<ChatSummaryChart[]>(row.summary_charts_json, []),
    referenced_cell_ids: parseJson<string[]>(row.referenced_cell_ids, []),
    created_at: row.created_at
  }
}

export function listChatMessages(notebookId: string): ChatMessage[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM notebook_chat_messages WHERE notebook_id = ? ORDER BY created_at ASC, id ASC`
  ).all(notebookId) as any[]
  return rows.map(rowToMessage)
}

export interface InsertChatMessageInput {
  notebookId: string
  role: 'user' | 'assistant'
  content: string
  dsl?: string | null
  aggregations?: ChatAggregation[]
  summaryCharts?: ChatSummaryChart[]
  referencedCellIds?: string[]
}

export function insertChatMessage(input: InsertChatMessageInput): ChatMessage {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const aggregationsJson = input.aggregations && input.aggregations.length
    ? JSON.stringify(input.aggregations)
    : null
  const summaryChartsJson = input.summaryCharts && input.summaryCharts.length
    ? JSON.stringify(input.summaryCharts)
    : null
  const refIdsJson = input.referencedCellIds && input.referencedCellIds.length
    ? JSON.stringify(input.referencedCellIds)
    : null

  db.prepare(
    `INSERT INTO notebook_chat_messages
       (id, notebook_id, role, content, dsl, aggregations_json, summary_charts_json, referenced_cell_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.notebookId,
    input.role,
    input.content,
    input.dsl ?? null,
    aggregationsJson,
    summaryChartsJson,
    refIdsJson,
    now
  )

  const row = db.prepare('SELECT * FROM notebook_chat_messages WHERE id = ?').get(id) as any
  return rowToMessage(row)
}

export function clearChatMessages(notebookId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM notebook_chat_messages WHERE notebook_id = ?').run(notebookId)
}
