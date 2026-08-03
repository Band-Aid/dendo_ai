/**
 * Shared epoch ↔ human-readable date formatting for charts and tables.
 *
 * Pendo's aggregation responses encode `day` / `firstDay` / `lastDay` etc. as
 * ms-since-epoch numbers, but other sources (or downstream tools) might emit
 * second-epoch numbers, ISO strings, or numeric strings. We normalize all of
 * those to a friendly short date, with year omitted when it matches the
 * current year for tidier chart axes.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

// Heuristic boundaries — chosen so that "any plausible recent epoch" maps
// correctly without false-positive on small integers that happen to be in the
// numeric range.
const MS_EPOCH_MIN = 1_000_000_000_000  // 2001-09-09 in ms
const MS_EPOCH_MAX = 4_000_000_000_000  // 2096 in ms — generous upper bound
const SEC_EPOCH_MIN = 1_000_000_000     // 2001-09-09 in seconds
const SEC_EPOCH_MAX = 4_000_000_000     // 2096 in seconds

function parseToDate(value: unknown): Date | null {
  if (value == null) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= MS_EPOCH_MIN && value <= MS_EPOCH_MAX) return new Date(value)
    if (value >= SEC_EPOCH_MIN && value <= SEC_EPOCH_MAX) return new Date(value * 1000)
    return null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    // Pure-numeric strings — try the same epoch heuristics.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (Number.isFinite(n)) return parseToDate(n)
    }
    if (ISO_DATE_RE.test(trimmed)) {
      const d = new Date(trimmed)
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  return null
}

export interface FormatDateOptions {
  /** Pass when the caller knows the value should always be treated as a date —
   *  forces conversion even when value would otherwise look like a small number. */
  forceDate?: boolean
  /** Override the current locale. */
  locale?: string
}

/**
 * Convert an epoch-ish value to a short, axis-friendly label. Year is omitted
 * when the date falls in the current year. Falls back to `String(value)` when
 * the value doesn't look like a date.
 */
export function formatDateValue(value: unknown, opts: FormatDateOptions = {}): string {
  const d = parseToDate(value)
  if (!d) return value == null ? '' : String(value)

  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const fmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }
  return d.toLocaleDateString(opts.locale, fmt)
}

/**
 * Heuristic: is this value something we'd format as a date?
 * Centralized so chart inference, table renderers, and series labels all agree.
 */
export function isDateLike(value: unknown): boolean {
  return parseToDate(value) !== null
}

/**
 * Column-name regex for "this column is a date" — kept here so the inference
 * code and renderers share one source of truth. Covers Pendo's standard time
 * columns plus common variants (firstTime / lastTime / hour / quarter, etc.).
 */
export const DATE_COLUMN_NAME_RE = /^(day|date|time|hour|week|month|quarter|period|firstDay|lastDay|firstTime|lastTime|firstSeen|lastSeen|firstTimeSeen|lastTimeSeen|firstVisit|lastVisit|firstActive|lastActive|firstActiveTs|lastActiveTs|timestamp|startTime|endTime|createdAt|updatedAt|publishedAt|expiresAt)$/i

/**
 * Stronger heuristic for "this whole column is dates" — checks multiple
 * non-null samples instead of just the first row. Catches cases where the
 * column name doesn't match our regex (anonymous epoch fields) and where the
 * first row's value happens to be null. A column counts as date-like when
 * ≥80% of its sampled non-null values parse as a date AND there's at least
 * one such sample.
 */
export function columnLooksLikeDates(rows: Record<string, unknown>[], column: string): boolean {
  if (DATE_COLUMN_NAME_RE.test(column)) return true
  let total = 0
  let hits = 0
  // Cap at 20 samples — enough to be confident, cheap enough to not matter on
  // large result sets.
  for (const r of rows) {
    if (total >= 20) break
    const v = r[column]
    if (v == null) continue
    total++
    if (isDateLike(v)) hits++
  }
  return total > 0 && hits / total >= 0.8
}
