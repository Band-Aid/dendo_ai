import { readAdminState } from '~/server/utils/adminStore'
import { runAggregation, extractRowsColumns } from '~/server/utils/aggregation'
import { readOverlay, writeOverlay, readOntology } from '~/server/utils/ontologyStore'
import { ontologyOverlaySchema } from '~/server/utils/schemas'
import type { OverlayMetrics } from '~/types/ontology'

/** Overlay results are shared per org and refresh at most hourly by default. */
const OVERLAY_TTL_MS = 60 * 60 * 1000

/**
 * 30d usage per feature and page — the "paint" on the product map. Runs two
 * canonical aggregations (syntax mirrors examples/feature_events__top10_by_
 * events__last30d__*.dsl) in parallel; a per-source failure degrades that
 * source rather than failing the whole overlay. Cached in kv (survives dev
 * restarts) under its own key, never inside the ontology blob.
 */
function buildDsl(source: 'featureEvents' | 'pageEvents', appId?: number): string {
  const idField = source === 'featureEvents' ? 'featureId' : 'pageId'
  const appParam = appId != null ? `,appId=${appId}` : ''
  return [
    `FROM event([source=${source}${appParam},blacklist="apply"])`,
    // NOT `first=now()-30` — that's now minus 30 MILLISECONDS, a window that
    // starts today and runs into the future (one lonely bucket of today's
    // partial data). Same trap documented in conceptKpi.ts; pattern mirrors
    // examples/feature_events__top10_by_events__last30d__*.dsl.
    'TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -30, "days") count=30',
    `| group by ${idField} fields {`,
    '    events30d = sum(numEvents),',
    '    visitors30d = count(visitorId)',
    '  }',
    '| sort -events30d',
    '| limit 300'
  ].join('\n')
}

async function runUsage(
  source: 'featureEvents' | 'pageEvents',
  orgId: string,
  appId?: number
): Promise<{ rows: Record<string, unknown>[] } | { error: string }> {
  const res = await runAggregation(buildDsl(source, appId), true, undefined, orgId)
  if (!res.success) return { error: res.error || 'aggregation failed' }
  return { rows: extractRowsColumns(res.data).rows }
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const body = await readBody(event).catch(() => ({}))
  const { force } = ontologyOverlaySchema.parse(body ?? {})

  const cached = readOverlay(orgId)
  if (cached && !force && Date.now() - new Date(cached.fetchedAt).getTime() < OVERLAY_TTL_MS) {
    return { ...cached, fromCache: true }
  }

  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) {
    throw createError({ statusCode: 400, message: 'Pendo API key not configured. Set it in Admin → Pendo Configuration.' })
  }
  // Prefer the appId sync actually validated against real entities — the
  // configured defaultAppId may be a subscription id that the aggregation
  // API rejects (see appIdMismatch handling in ontologyBuilder).
  const appId = readOntology(orgId).structural.effectiveAppId ?? state.pendo?.defaultAppId

  const [features, pages] = await Promise.all([
    runUsage('featureEvents', orgId, appId),
    runUsage('pageEvents', orgId, appId)
  ])

  const metrics: OverlayMetrics['metrics'] = {}
  const errors: NonNullable<OverlayMetrics['errors']> = {}

  if ('rows' in features) {
    for (const r of features.rows) {
      const id = r.featureId != null ? String(r.featureId) : null
      if (id) metrics[`feature:${id}`] = { events30d: Number(r.events30d) || 0, visitors30d: Number(r.visitors30d) || 0 }
    }
  } else {
    errors.features = features.error
  }

  if ('rows' in pages) {
    for (const r of pages.rows) {
      const id = r.pageId != null ? String(r.pageId) : null
      if (id) metrics[`page:${id}`] = { events30d: Number(r.events30d) || 0, visitors30d: Number(r.visitors30d) || 0 }
    }
  } else {
    errors.pages = pages.error
  }

  if ('error' in features && 'error' in pages) {
    throw createError({ statusCode: 502, message: `Usage overlay failed: ${features.error}; ${pages.error}` })
  }

  const overlay: OverlayMetrics = {
    fetchedAt: new Date().toISOString(),
    metrics,
    ...(Object.keys(errors).length ? { errors } : {})
  }
  writeOverlay(orgId, overlay)
  return { ...overlay, fromCache: false }
})
