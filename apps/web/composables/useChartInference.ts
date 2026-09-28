import type { ChartType } from '~/types/notebook'
import { numericValue } from '../utils/chartEngine.ts'
import { DATE_COLUMN_NAME_RE, isDateLike } from './useDateFormat.ts'

export interface ChartConfig { type: ChartType; xField: string; yField: string; title?: string }

/** Suggest a starting view across non-empty samples; explicit chart settings remain editable. */
export function inferChartConfig(rows: Record<string, unknown>[], columns: string[]): ChartConfig | null {
  if (!rows.length || !columns.length) return null
  const samples = rows.slice(0, 30)
  const time = columns.find(c => DATE_COLUMN_NAME_RE.test(c) && samples.some(r => isDateLike(r[c])))
  const numeric = columns.filter(c => c !== time && samples.some(r => numericValue(r[c]) !== null))
  if (!numeric.length) return null
  const y = numeric[0]
  if (time) return { type: 'line', xField: time, yField: y, title: y }
  if (columns.length === 1 || rows.length === 1 && !columns.some(c => !numeric.includes(c))) return { type: 'metric', xField: columns[0], yField: y, title: y }
  const category = columns.find(c => !numeric.includes(c))
  if (category) return { type: 'bar', xField: category, yField: y, title: y }
  if (numeric.length >= 2) return { type: 'scatter', xField: numeric[0], yField: numeric[1], title: `${numeric[1]} by ${numeric[0]}` }
  return { type: 'bar', xField: columns.find(c => c !== y) || y, yField: y, title: y }
}
