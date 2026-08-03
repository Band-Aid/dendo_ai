import { readAdminState } from '~/server/utils/adminStore'
import { runAggregation, extractRowsColumns, normalizeDslText } from '~/server/utils/aggregation'
import {
  readOntology,
  readConceptMetrics,
  writeConceptMetrics
} from '~/server/utils/ontologyStore'
import { buildMeasuresKpiDsl, extractKpi } from '~/server/utils/conceptKpi'
import { conceptMetricsSchema } from '~/server/utils/schemas'
import type { ConceptMetric, ConceptMetricsBlob, OntologyConcept, OntologyEntityNode } from '~/types/ontology'

/** Concept KPIs share the overlay's refresh posture: hourly, org-wide. */
const METRICS_TTL_MS = 60 * 60 * 1000
/** Each run is a python subprocess — bound the herd at the MAX_CONCEPTS ceiling. */
const MAX_CONCURRENT = 6

/**
 * Live KPI per concept — the number that turns a concept node from a label
 * into a scorecard entry. Source of truth per concept: its dslTemplate (run
 * raw, like the overlay — deliberately NOT the compile path, so notebook
 * default segments never leak in), else a canonical usage query derived from
 * its measures. Per-concept failure degrades that concept only; concepts
 * invalidated by an edit are recomputed individually while the rest of the
 * cache stays warm.
 */
async function computeMetric(
  concept: OntologyConcept,
  nodes: OntologyEntityNode[],
  appId: number | undefined,
  orgId: string
): Promise<ConceptMetric> {
  const template = concept.dslTemplate?.trim()
  const canonical = buildMeasuresKpiDsl(concept.measures, nodes, appId)
  if (!template && !canonical) {
    return { value: 0, label: 'no data', source: 'measures', error: 'no dslTemplate or usable measures' }
  }

  /** One attempt: run a template (DSL text or pasted JSON pipeline) or the
   *  canonical measures query, and distill a KPI. */
  const attempt = async (
    query: string,
    source: ConceptMetric['source'],
    headline: 'latest' | 'windowSum'
  ): Promise<ConceptMetric> => {
    // Users (and agents) sometimes paste an already-compiled JSON pipeline
    // into dslTemplate. runAggregation handles both — just don't send JSON
    // down the DSL-text parse path, and wrap a bare {"pipeline": [...]} in
    // the request envelope the aggregation runner expects.
    let body = query
    let isDslText = true
    if (query.startsWith('{')) {
      isDslText = false
      try {
        const parsed = JSON.parse(query)
        if (parsed.pipeline && !parsed.request) {
          body = JSON.stringify({
            response: { location: 'request', mimeType: 'application/json' },
            request: { pipeline: parsed.pipeline }
          })
        }
      } catch {
        return { value: 0, label: 'no data', source, error: 'dslTemplate is neither valid aggDSL nor valid JSON' }
      }
    } else {
      // LLM-written one-liners fail the line-oriented parser.
      body = normalizeDslText(query)
    }
    try {
      const res = await runAggregation(body, isDslText, undefined, orgId)
      if (!res.success) {
        return { value: 0, label: 'no data', source, error: res.error || 'aggregation failed' }
      }
      const { rows, columns } = extractRowsColumns(res.data)
      return extractKpi(rows, columns, { kpiColumn: concept.kpiColumn, source, headline })
    } catch (err: any) {
      return { value: 0, label: 'no data', source, error: err.message || 'aggregation failed' }
    }
  }

  if (!template) return attempt(canonical!, 'measures', 'windowSum')

  // The canonical daily-usage query (measures-derived, or a template that
  // suggest auto-drafted from the same builder) headlines the 30d sum —
  // "events in the last 30d" beats "events yesterday". Hand-written
  // templates keep the latest-value read.
  const fromTemplate = await attempt(template, 'template', template !== canonical ? 'latest' : 'windowSum')
  // A broken template (unsupported stage, bad syntax) shouldn't leave the
  // concept dark when its measures can still tell the usage story. An empty
  // result is not a failure though: a template that legitimately returns no
  // rows keeps its honest zero instead of being replaced by a generic usage
  // number.
  if (!fromTemplate.error || fromTemplate.error === 'query returned no rows' || !canonical) {
    return fromTemplate
  }
  const fallback = await attempt(canonical, 'measures', 'windowSum')
  if (fallback.error) return fromTemplate // surface the template's error, it's the root cause
  return { ...fallback, label: `${fallback.label} — dslTemplate failed, showing usage of measures` }
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const body = await readBody(event).catch(() => ({}))
  const { force } = conceptMetricsSchema.parse(body ?? {})

  const ontology = readOntology(orgId)
  const concepts = ontology.concepts
  if (concepts.length === 0) {
    return { fetchedAt: new Date().toISOString(), metrics: {}, fromCache: false }
  }

  const cached = readConceptMetrics(orgId)
  const cacheFresh =
    cached && !force && Date.now() - new Date(cached.fetchedAt).getTime() < METRICS_TTL_MS

  // Errors worth caching for the TTL: anything deterministic (a template
  // that doesn't parse fails identically every time — retrying each page
  // load just burns subprocesses). Only timeouts/cancellations retry early.
  const isDurable = (m: ConceptMetric | undefined) =>
    m && (!m.error || !/timed out|cancelled/i.test(m.error))

  // Fresh cache, but recompute concepts whose entries were invalidated by an
  // edit (or created since, or failed transiently) instead of serving nothing
  // for them for an hour.
  const stale = cacheFresh
    ? concepts.filter(c => !isDurable(cached!.metrics[c.id]))
    : concepts
  if (cacheFresh && stale.length === 0) {
    return { ...cached!, fromCache: true }
  }

  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) {
    throw createError({ statusCode: 400, message: 'Pendo API key not configured. Set it in Admin → Pendo Configuration.' })
  }
  const appId = ontology.structural.effectiveAppId ?? state.pendo?.defaultAppId

  const metrics: ConceptMetricsBlob['metrics'] = cacheFresh ? { ...cached!.metrics } : {}
  for (let i = 0; i < stale.length; i += MAX_CONCURRENT) {
    const chunk = stale.slice(i, i + MAX_CONCURRENT)
    const results = await Promise.all(
      chunk.map(c => computeMetric(c, ontology.structural.nodes, appId, orgId))
    )
    chunk.forEach((c, j) => { metrics[c.id] = results[j] })
  }

  // Never 502 the map because a user artifact is broken — errors are
  // per-card results the panel can show. But when EVERYTHING errored
  // (Pendo outage, or the sole concept is broken), skip the cache write so
  // the next load retries instead of serving an hour of nothing.
  const all = concepts.map(c => metrics[c.id]).filter(Boolean)
  const allFailed = all.length > 0 && all.every(m => m.error)

  const blob: ConceptMetricsBlob = {
    fetchedAt: cacheFresh ? cached!.fetchedAt : new Date().toISOString(),
    metrics
  }
  if (!allFailed) writeConceptMetrics(orgId, blob)
  return { ...blob, fromCache: false }
})
