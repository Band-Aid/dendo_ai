import { randomUUID } from 'node:crypto'
import { getDb, dbGetJson, dbSetJson } from '../db/client'
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
  /**
   * Use this id instead of a fresh one. The agent stream pre-generates the
   * assistant message's id so the same value identifies the message in the
   * database, in the UI, and as the Pendo `agent_response` — which is what lets
   * a later interaction be attributed to this exact answer.
   */
  id?: string
}

export function insertChatMessage(input: InsertChatMessageInput): ChatMessage {
  const db = getDb()
  const id = input.id ?? randomUUID()
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
  // Wiping the history ends the thread, so the analytics conversation ends with
  // it. Rotated here rather than in the endpoint so the two can never drift:
  // any future caller that clears a notebook's chat starts a new conversation.
  rotateChatConversationId(notebookId)
}

// --- Analytics conversation identity ---------------------------------------
//
// The id that groups this notebook's chat turns into a single conversation in
// Pendo Agent Analytics. It lives in the database beside the messages, not in
// the browser: the client's `sessionId` is regenerated on every page load, so
// keying off it would split one continuous chat into a new conversation each
// time the user reloaded or navigated back to the notebook.
//
// Lifetime therefore matches the visible thread — created with the first turn,
// stable across reloads and across browsers, and retired only when the user
// clears the chat.

function conversationKey(notebookId: string): string {
  return `chat_conversation:${notebookId}`
}

function newConversationId(): string {
  return `nbchat:${randomUUID()}`
}

/**
 * The current analytics conversation id for a notebook's chat, minting one on
 * first use.
 */
export function getOrCreateChatConversationId(notebookId: string): string {
  const existing = dbGetJson<{ id?: string }>(conversationKey(notebookId), {})
  if (existing.id) return existing.id

  const id = newConversationId()
  dbSetJson(conversationKey(notebookId), { id })
  return id
}

/** Start a fresh conversation for this notebook's chat. */
export function rotateChatConversationId(notebookId: string): string {
  const id = newConversationId()
  dbSetJson(conversationKey(notebookId), { id })
  return id
}
