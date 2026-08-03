import type { ChartType } from '~/types/notebook'

export interface ChartConfig {
  type: ChartType
  xField: string
  yField: string
  title?: string
}

function isTimeValue(v: unknown): boolean {
  if (typeof v === 'number' && v > 1_000_000_000) return true
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return true
  return false
}

/**
 * Suggest a chart type + axis fields for a single aggregation result. Used by
 * the result-cell table/chart toggle and the chat "Add chart" action.
 *
 * Combining multiple aggregations into one chart is intentionally NOT inferred
 * here — that path goes through the agent's `build_summary_chart` tool so the
 * comparison key and metric are an explicit model decision, not a guess from
 * raw shape.
 */
export function inferChartConfig(
  rows: Record<string, unknown>[],
  columns: string[]
): ChartConfig | null {
  if (!rows.length || columns.length < 2) return null

  const timeCol = columns.find(c =>
    /day|date|time|week|month|period/i.test(c) && isTimeValue(rows[0][c])
  )

  if (timeCol) {
    const numericCol = columns.find(c => c !== timeCol && typeof rows[0][c] === 'number')
    if (numericCol) {
      return { type: 'line', xField: timeCol, yField: numericCol, title: numericCol }
    }
  }

  if (typeof rows[0][columns[0]] === 'string' && typeof rows[0][columns[1]] === 'number') {
    return { type: 'bar', xField: columns[0], yField: columns[1], title: columns[1] }
  }

  return null
}
