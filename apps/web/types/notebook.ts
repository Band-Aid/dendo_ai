export type CellType = 'note' | 'query' | 'result' | 'chart' | 'agent_message' | 'insight' | 'question'

export interface NoteCell {
  id: string
  cell_type: 'note'
  position: number
  content: string
  meta_json: Record<string, never>
  source_cell_id: null
  created_at: string
  updated_at: string
}

export interface QueryCellMeta {
  lastRunAt?: string | null
  lastError?: string | null
  /**
   * User-given name for the query. Purely a label — it identifies the cell in
   * a long notebook and is copied onto the paired result cell's `title` on
   * every run, so the table carries the same name as the query behind it.
   */
  title?: string
}

export interface QueryCell {
  id: string
  cell_type: 'query'
  position: number
  content: string
  meta_json: QueryCellMeta
  source_cell_id: null
  created_at: string
  updated_at: string
}

export interface ResultCellMeta {
  rows: Record<string, unknown>[]
  columns: string[]
  rowCount: number
  dsl: string
  runAt: string
  /** Optional descriptive title — typically the agent's `explanation` from
   *  the chat aggregation that produced this result. Cells created from a
   *  raw cell-run (user-typed DSL) leave this empty. */
  title?: string
  /**
   * User-defined column display order. When present, the table renders these
   * columns in this order; any column in `columns` not listed here is
   * appended at the end so newly-arrived fields (after a refresh) remain
   * visible. Empty / unset → use `columns` order.
   */
  columnOrder?: string[]
}

export interface ResultCell {
  id: string
  cell_type: 'result'
  position: number
  content: string
  meta_json: ResultCellMeta
  source_cell_id: string | null
  created_at: string
  updated_at: string
}

export type ChartType = 'line' | 'bar' | 'donut'

/**
 * One labeled data set inside a multi-series chart. Each series comes from a
 * separate aggregation response so we can render a "summary chart" combining
 * multiple Pendo queries (e.g. one PES query per persona) into a single view.
 */
export interface ChartSeries {
  /** Legend label / slice name. */
  name: string
  rows: Record<string, unknown>[]
  /** Per-series x/y override; falls back to the cell-level fields when omitted. */
  xField?: string
  yField?: string
  /** Source result-cell id if this series came from a saved result cell. */
  sourceResultCellId?: string | null
  /** Original DSL — purely informational, not used by the renderer. */
  dsl?: string
}

export interface ChartCellMeta {
  chartType: ChartType
  title: string
  /**
   * Multi-series payload. When present and non-empty the renderer plots one
   * series per entry; otherwise it falls back to the single-series fields below.
   */
  series?: ChartSeries[]
  /** Single-series (legacy single-aggregation cells). */
  xField?: string
  yField?: string
  sourceResultCellId?: string
  rows?: Record<string, unknown>[]
  columns?: string[]
  /**
   * aggDSL backing this chart. Stored on single-series charts; multi-series
   * charts put one DSL per series instead (on `ChartSeries.dsl`). Presence
   * (here OR on any series) gates the "Refresh" affordance — charts without
   * any DSL (e.g. agent-built `build_summary_chart` specs with pre-computed
   * points) can't be re-run.
   */
  dsl?: string
}

export interface ChartCell {
  id: string
  cell_type: 'chart'
  position: number
  content: string
  meta_json: ChartCellMeta
  source_cell_id: string | null
  created_at: string
  updated_at: string
}

export interface DataAttachment {
  dsl: string
  rows: Record<string, unknown>[]
  columns: string[]
  explanation?: string
}

export interface AgentMessageMeta {
  role: 'agent'
  dataAttachments?: DataAttachment[]
  insightSummary?: string
}

export interface AgentMessageCell {
  id: string
  cell_type: 'agent_message'
  position: number
  content: string
  meta_json: AgentMessageMeta
  source_cell_id: null
  created_at: string
  updated_at: string
}

export interface InsightCellMeta {
  severity: 'info' | 'warning' | 'anomaly'
  metric?: string
  comparisons?: string[]
}

export interface InsightCell {
  id: string
  cell_type: 'insight'
  position: number
  content: string
  meta_json: InsightCellMeta
  source_cell_id: null
  created_at: string
  updated_at: string
}

/**
 * A re-runnable saved question. Unlike a result/chart cell (which freezes the
 * output of a single aggregation), a question cell stores the natural-language
 * prompt and re-asks the agent on demand — regenerating the answer and *all*
 * the data it pulls, however many sources it combines. This is what makes a
 * multi-source agent answer reusable: the question is the durable artifact,
 * not the snapshot.
 */
export interface QuestionCellMeta {
  /** Agent's last text answer (markdown). */
  answer?: string
  /** Every aggregation the agent ran on the last turn — possibly several
   *  sources combined into one answer. */
  aggregations?: ChatAggregation[]
  /** Agent-built summary charts from the last run. */
  summaryCharts?: ChatSummaryChart[]
  /** ISO timestamp of the last successful run. */
  lastRunAt?: string | null
  /** Error message from the last failed run (cleared on success). */
  lastError?: string | null
  /** The exact question text that produced the stored DSLs. Used to detect
   *  when the user has rephrased the question so we re-derive queries instead
   *  of replaying stale ones. */
  lastRunQuestion?: string
  /** Set when this cell was created from a concept's cause/action/KPI on the
   *  Product map. Threaded back to buildOntologyDigest on every run/re-run so
   *  the agent gets that concept's full measures/DSL template inlined instead
   *  of re-deriving tags/segments from the question text alone. */
  originConceptId?: string
}

export interface QuestionCell {
  id: string
  cell_type: 'question'
  /** The natural-language question, re-sent to the agent on each run. */
  content: string
  position: number
  meta_json: QuestionCellMeta
  source_cell_id: null
  created_at: string
  updated_at: string
}

export type NotebookCell = NoteCell | QueryCell | ResultCell | ChartCell | AgentMessageCell | InsightCell | QuestionCell

export interface Notebook {
  id: string
  org_id: string
  title: string
  description?: string | null
  /** Segment ID applied as a default filter to all aggregations in this notebook (cells + chat) unless explicitly overridden. */
  default_segment_id?: string | null
  /** Human-readable name for the default segment, surfaced in UI and the agent prompt. */
  default_segment_name?: string | null
  created_at: string
  updated_at: string
}

export interface NotebookWithCells extends Notebook {
  cells: NotebookCell[]
}

export interface ChatAggregation {
  dsl: string
  rows: Record<string, unknown>[]
  columns: string[]
  explanation?: string
}

/**
 * A chart spec the agent builds explicitly via the `build_summary_chart` tool.
 * Unlike `ChatAggregation` (raw query output), this is a *designed* chart —
 * the agent has already chosen the comparison key and the metric to plot, so
 * we don't have to guess from raw shape. Each series is a labeled set of
 * points; series with a single point render as one bar/slice, series with
 * many points render as one line/grouped-bar.
 */
export interface ChatSummaryChartPoint {
  label: string
  value: number
}
export interface ChatSummaryChartSeries {
  name: string
  points: ChatSummaryChartPoint[]
}
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

// SSE event types emitted by the agent stream endpoint
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; tool: string; explanation?: string }
  | { type: 'tool_result'; success: boolean; rowCount?: number; truncated?: boolean }
  | { type: 'message_created'; message: ChatMessage }
  | { type: 'done'; reason: 'finish' | 'limit' | 'error' }
  | { type: 'error'; message: string }
