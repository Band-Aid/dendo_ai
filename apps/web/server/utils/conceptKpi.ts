import type { ConceptMetric, OntologyEntityNode } from '~/types/ontology'

/**
 * Concept KPI mechanics — both halves pure and side-effect free:
 *  - buildMeasuresKpiDsl: canonical usage DSL for concepts that have measures
 *    but no hand-written dslTemplate (also reused by suggest to auto-draft
 *    templates for proposals).
 *  - extractKpi: turn an arbitrary aggregation result into one honest number.
 */

/** 60 days so one call yields an exact 30d-vs-30d delta — never run twice. */
export const KPI_WINDOW_DAYS = 60
export const KPI_HEADLINE_DAYS = 30

/**
 * Canonical daily-usage DSL over a concept's measures. Features win over
 * pages (one source per query); segments are skipped — a segment is a filter,
 * not an event source. Returns null when no feature/page measures exist.
 *
 * Spec constraint: the aggregation API rejects `in [...]` — multi-id filters
 * must be an `||` equality chain. `measures` is schema-capped at 20 ids.
 */
export function buildMeasuresKpiDsl(
  measures: string[],
  nodes: OntologyEntityNode[],
  appId?: number
): string | null {
  const pendoIdByNodeId = new Map(nodes.map(n => [n.id, n.pendoId]))
  const idsFor = (prefix: 'feature' | 'page') =>
    measures
      .filter(m => m.startsWith(`${prefix}:`))
      .map(m => pendoIdByNodeId.get(m))
      .filter((id): id is string => Boolean(id))

  const featureIds = idsFor('feature')
  const pageIds = featureIds.length ? [] : idsFor('page')
  if (featureIds.length === 0 && pageIds.length === 0) return null

  const source = featureIds.length ? 'featureEvents' : 'pageEvents'
  const idField = featureIds.length ? 'featureId' : 'pageId'
  const ids = featureIds.length ? featureIds : pageIds
  const appParam = appId != null ? `,appId=${appId}` : ''
  const filter = ids.map(id => `${idField} == "${id}"`).join(' || ')

  return [
    `FROM event([source=${source}${appParam},blacklist="apply"])`,
    // NOT `first=now()-N` — that is now minus N *milliseconds*, which starts
    // the window today and runs into the future (one lonely bucket of data).
    `TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -${KPI_WINDOW_DAYS}, "days") count=${KPI_WINDOW_DAYS}`,
    `| filter ${filter}`,
    '| group by day fields {',
    '    events = sum(numEvents),',
    '    visitors = count(visitorId)',
    '  }',
    '| sort day'
  ].join('\n')
}

const TEMPLATE_ID_RE = /(?:featureId|pageId)\s*==\s*"([^"]+)"/g
const TEMPLATE_APP_ID_RE = /appId=(\d+)/

export interface TemplateSync {
  /** True when the template is byte-identical to what `buildMeasuresKpiDsl`
   *  produces for the ids it filters on — i.e. nobody hand-edited it. */
  derived: boolean
  /** Set when a derived template no longer matches `measures`: the rebuilt
   *  template the caller should persist in its place. */
  next?: string
  /** Hand-written templates only — filtered ids the concept no longer
   *  measures. Reported, never rewritten. */
  staleIds: string[]
  /** Hand-written templates only — measured entities of the kind the template
   *  filters on that it never references. */
  missingIds: string[]
}

/**
 * Keep a concept's dslTemplate honest about its measures.
 *
 * The template embeds concrete pendoIds, so editing the measured entities
 * leaves it pointing at the old ones — and every query path prefers the
 * template (concept KPIs run it, the digest hands it to the agent), so the
 * concept silently keeps reporting the entities it no longer claims to
 * measure. No error is raised anywhere; the number is just wrong.
 *
 * Provenance is INFERRED rather than stored: a template is machine-derived iff
 * rebuilding the canonical DSL from the ids it filters on reproduces it byte
 * for byte. Derived templates are rebuilt from the current measures; anything
 * hand-edited (even a one-word change to a generated template) is left alone
 * and only reported as drift. Retroactive by construction — concepts saved
 * before this existed classify correctly with no migration.
 */
export function syncKpiDslToMeasures(
  template: string | undefined,
  measures: string[],
  nodes: OntologyEntityNode[],
  appId?: number
): TemplateSync {
  const tpl = template?.trim()
  if (!tpl) return { derived: false, staleIds: [], missingIds: [] }

  const refs = [...tpl.matchAll(TEMPLATE_ID_RE)].map(m => m[1])
  // A template with no id equality filter (a custom aggregate, a pasted JSON
  // pipeline) says nothing about which entities it covers — no drift to claim.
  if (refs.length === 0) return { derived: false, staleIds: [], missingIds: [] }

  const nodeByPendoId = new Map(nodes.map(n => [n.pendoId, n]))
  const refNodeIds = refs.map(p => nodeByPendoId.get(p)?.id).filter((id): id is string => Boolean(id))
  const appIdMatch = tpl.match(TEMPLATE_APP_ID_RE)
  // Rebuild with the template's OWN appId so a changed workspace appId reads as
  // drift to repair, not as a hand edit.
  const rebuilt = refs.length === refNodeIds.length
    ? buildMeasuresKpiDsl(refNodeIds, nodes, appIdMatch ? Number(appIdMatch[1]) : undefined)
    : null

  if (rebuilt !== null && rebuilt === tpl) {
    const next = buildMeasuresKpiDsl(measures, nodes, appId)
    // A measure set with nothing queryable left (all segments, or emptied)
    // keeps the old template rather than dropping to no KPI at all.
    return { derived: true, staleIds: [], missingIds: [], ...(next && next !== tpl ? { next } : {}) }
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const measured = measures
    .map(id => nodeById.get(id))
    .filter((n): n is OntologyEntityNode => Boolean(n))
  const measuredPendoIds = new Set(measured.map(n => n.pendoId))
  // Only the kind the template actually filters on can be "missing" from it —
  // a featureId template ignoring the concept's pages is the canonical shape,
  // not drift.
  const kind = tpl.includes('featureId ==') ? 'feature' : 'page'
  return {
    derived: false,
    staleIds: [...new Set(refs.filter(p => !measuredPendoIds.has(p)))],
    missingIds: measured
      .filter(n => n.kind === kind && !refs.includes(n.pendoId))
      .map(n => n.pendoId)
  }
}

const TIME_COL_RE = /^(day|date|time|week|month|hour|period|ts|timestamp)$/i
const ID_COL_RE = /id$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

function toTimeMs(v: unknown): number | null {
  if (typeof v === 'number' && v >= 1e12) return v
  if (typeof v === 'string' && ISO_DATE_RE.test(v)) {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

function isNumericColumn(rows: Record<string, unknown>[], col: string): boolean {
  let sawValue = false
  for (const r of rows) {
    const v = r[col]
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    sawValue = true
  }
  return sawValue
}

function findTimeColumn(rows: Record<string, unknown>[], columns: string[]): string | null {
  const byName = columns.find(c => TIME_COL_RE.test(c))
  if (byName) return byName
  for (const c of columns) {
    const vals = rows.map(r => r[c]).filter(v => v != null)
    if (vals.length && vals.every(v => toTimeMs(v) !== null)) return c
  }
  return null
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Distill an arbitrary aggregation result into one KPI. The heuristic is
 * never hidden: whatever aggregation was applied is spelled out in `label`.
 *
 *  - time series (≥2 rows): latest value, delta = newer half vs older half.
 *    With `headline: 'windowSum'` (the canonical measures query): sum of the
 *    last KPI_HEADLINE_DAYS *calendar days*, delta vs the same-length window
 *    before it — sliced by date, never by row count, because group-by-day
 *    omits empty days and the newest N rows of a sparse series reach back
 *    past the window.
 *  - single row: its first numeric column.
 *  - multi-row categorical: sum, labeled `Σ <col> (<n> rows)`.
 *  - no numeric column at all: row count.
 */
export function extractKpi(
  rows: Record<string, unknown>[],
  columns: string[],
  opts: { kpiColumn?: string; source: ConceptMetric['source']; headline?: 'latest' | 'windowSum' }
): ConceptMetric {
  const { kpiColumn, source } = opts
  if (rows.length === 0) {
    return { value: 0, label: 'no data', source, error: 'query returned no rows' }
  }

  const timeCol = findTimeColumn(rows, columns)
  const metricCol =
    (kpiColumn && columns.includes(kpiColumn) ? kpiColumn : undefined) ??
    columns.find(c => c !== timeCol && !ID_COL_RE.test(c) && isNumericColumn(rows, c))

  if (!metricCol) {
    return { value: rows.length, label: 'rows', source }
  }

  const num = (r: Record<string, unknown>) => {
    const v = r[metricCol]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }

  // Time series → latest value + halves-based delta + series.
  if (timeCol && rows.length >= 2) {
    const sorted = [...rows]
      .filter(r => toTimeMs(r[timeCol]) !== null)
      .sort((a, b) => toTimeMs(a[timeCol])! - toTimeMs(b[timeCol])!)
    if (sorted.length >= 2) {
      const series = sorted.slice(-400).map(r => ({
        date: new Date(toTimeMs(r[timeCol])!).toISOString().slice(0, 10),
        value: num(r)
      }))
      if (opts.headline === 'windowSum') {
        const dayMs = 86_400_000
        const headlineStart = Date.now() - KPI_HEADLINE_DAYS * dayMs
        const sum = (rs: typeof sorted) => rs.reduce((acc, r) => acc + num(r), 0)
        const value = sum(sorted.filter(r => toTimeMs(r[timeCol])! >= headlineStart))
        const prevSum = sum(sorted.filter(r => {
          const t = toTimeMs(r[timeCol])!
          return t >= headlineStart - KPI_HEADLINE_DAYS * dayMs && t < headlineStart
        }))
        const metric: ConceptMetric = {
          value,
          label: `${metricCol} (${KPI_HEADLINE_DAYS}d)`,
          series,
          source
        }
        if (prevSum !== 0) metric.delta = (value - prevSum) / prevSum
        return metric
      }
      const metric: ConceptMetric = {
        value: series[series.length - 1].value,
        label: `${metricCol} (latest)`,
        series,
        source
      }
      if (sorted.length >= 4) {
        const half = Math.floor(sorted.length / 2)
        const older = mean(sorted.slice(0, half).map(num))
        const newer = mean(sorted.slice(half).map(num))
        if (older !== 0) metric.delta = (newer - older) / older
      }
      return metric
    }
  }

  if (rows.length === 1) {
    return { value: num(rows[0]), label: metricCol, source }
  }

  const capped = rows.slice(0, 1000)
  return {
    value: capped.reduce((acc, r) => acc + num(r), 0),
    label: `Σ ${metricCol} (${capped.length} rows)`,
    source
  }
}
