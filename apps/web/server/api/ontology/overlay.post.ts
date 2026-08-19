import { readAdminState } from '~/server/utils/adminStore'
import { runAggregation, extractRowsColumns } from '~/server/utils/aggregation'
import { readOverlay, writeOverlay, readOntology } from '~/server/utils/ontologyStore'
import { ontologyOverlaySchema } from '~/server/utils/schemas'
import type { OverlayMetrics, OverlayWindow } from '~/types/ontology'

/** Overlay results are shared per org and refresh at most hourly by default. */
const OVERLAY_TTL_MS = 60 * 60 * 1000
/**
 * A window that includes today is still accumulating, so an hour-old copy of it
 * is an hour out of date rather than merely cached. Settled windows can't change
 * at all, which is what makes the long TTL safe for them.
 */
const PARTIAL_OVERLAY_TTL_MS = 5 * 60 * 1000

/** What the map shows when the user hasn't picked a range. */
export const DEFAULT_OVERLAY_DAYS = 30

/** Whole days between two `YYYY-MM-DD` days, inclusive of both ends. */
function inclusiveDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.floor(ms / 86_400_000) + 1
}

/**
 * Resolve the requested window into something the DSL can express.
 *
 * The default stays relative (`dateAdd(startOfPeriod(...))`) so it always means
 * "the last 30 complete days" no matter when it runs, and so the cached blob
 * from yesterday doesn't silently pin the map to yesterday's window. An
 * explicit range is absolute and is rendered with Pendo's `date()`, which
 * resolves in the subscription's timezone — the same timezone the day buckets
 * come back in, so a user picking "Aug 1" gets Aug 1 as Pendo reckons it rather
 * than as this server's clock does.
 */
function resolveWindow(from?: string, to?: string): { window: OverlayWindow; first: string; count: number } {
  if (from && to) {
    return { window: { from, to, days: inclusiveDays(from, to) }, first: dateExpr(from), count: inclusiveDays(from, to) }
  }
  // Relative default: provisional label only. It is computed in *this server's*
  // timezone, so it is replaced by `windowFromStartTime()` once Pendo reports
  // the instant it really used.
  const today = new Date()
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (DEFAULT_OVERLAY_DAYS - 1))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return {
    window: { from: iso(start), to: iso(end), days: DEFAULT_OVERLAY_DAYS, relative: true },
    // NOT `first=now()-30` — that's now minus 30 MILLISECONDS, a window that
    // starts today and runs into the future (one lonely bucket of today's
    // partial data). Same trap documented in conceptKpi.ts.
    first: `dateAdd(startOfPeriod("daily", now()), -${DEFAULT_OVERLAY_DAYS}, "days")`,
    count: DEFAULT_OVERLAY_DAYS
  }
}

/** `2026-08-01` → `date(2026, 8, 1, 0, 0, 0)` — Pendo evaluates it in the subscription tz. */
function dateExpr(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `date(${y}, ${m}, ${d}, 0, 0, 0)`
}

/**
 * Rebuild the window label from the `startTime` Pendo echoed back, so a relative
 * default is described by the days Pendo actually bucketed rather than by this
 * server's idea of "yesterday".
 *
 * `startTime` is the first bucket's midnight *in the subscription's timezone*,
 * expressed as epoch ms — for a JST subscription that is 15:00 UTC on the
 * previous calendar day, so reading the UTC date off it directly lands a day
 * early. The offset is recovered from how far the instant sits from a UTC
 * midnight: local midnight means `startTime + offset` is exactly a UTC midnight,
 * which pins the offset once we assume it lies in the real-world range
 * (-12h, +14h]. That covers every inhabited timezone except UTC-11/-12, which
 * alias onto +13/+12 and would shift the label by one day.
 */
const DAY_MS = 86_400_000
/** Real-world UTC offsets top out at +14h; see the caveat in `tzOffsetMs`. */
const MAX_AHEAD_MS = 14 * 3_600_000

/**
 * Recover the subscription's UTC offset from an instant known to be a local
 * midnight. Unambiguous for offsets in (-12h, +14h] — the only aliasing is
 * UTC-11/-12 onto +13/+12, which would shift a label by one day.
 */
function tzOffsetMs(localMidnight: number): number {
  const remainder = ((localMidnight % DAY_MS) + DAY_MS) % DAY_MS
  const ahead = (DAY_MS - remainder) % DAY_MS
  return ahead <= MAX_AHEAD_MS ? ahead : ahead - DAY_MS
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Today's calendar date as the Pendo subscription reckons it. */
function pendoToday(offset: number): string {
  return isoDay(Date.now() + offset)
}

function windowFromStartTime(startTime: number, days: number): OverlayWindow {
  const localMidnight = startTime + tzOffsetMs(startTime)
  return { from: isoDay(localMidnight), to: isoDay(localMidnight + (days - 1) * DAY_MS), days }
}

/**
 * Usage per feature, page, and Track Event over the chosen window — the
 * "paint" on the product map. Runs canonical aggregations (syntax mirrors
 * examples/feature_events__top10_by_events__last30d__*.dsl) in parallel; a
 * per-source failure degrades that source rather than failing the whole
 * overlay. Cached in kv (survives dev restarts) under its own key, never
 * inside the ontology blob.
 */
function buildDsl(
  source: 'featureEvents' | 'pageEvents' | 'trackEvents',
  appId: number | undefined,
  first: string,
  count: number
): string {
  const idField = source === 'featureEvents' ? 'featureId' : source === 'pageEvents' ? 'pageId' : 'trackTypeId'
  const appParam = appId != null ? `,appId=${appId}` : ''
  return [
    `FROM event([source=${source}${appParam},blacklist="apply"])`,
    `TIMESERIES period=dayRange first=${first} count=${count}`,
    `| group by ${idField} fields {`,
    '    events = sum(numEvents),',
    '    visitors = count(visitorId)',
    '  }',
    '| sort -events',
    '| limit 300'
  ].join('\n')
}

async function runUsage(
  source: 'featureEvents' | 'pageEvents' | 'trackEvents',
  orgId: string,
  appId: number | undefined,
  first: string,
  count: number
): Promise<{ rows: Record<string, unknown>[]; startTime?: number } | { error: string }> {
  const res = await runAggregation(buildDsl(source, appId, first, count), true, undefined, orgId)
  if (!res.success) return { error: res.error || 'aggregation failed' }
  // Pendo echoes the instant it actually started the window at, resolved in the
  // subscription's timezone. For the relative default that is the only truthful
  // source for the label — computing it here would use the *server's* timezone
  // and disagree with the data by a day whenever the two are on opposite sides
  // of midnight.
  const startTime = (res.data as any)?.startTime
  return {
    rows: extractRowsColumns(res.data).rows,
    ...(typeof startTime === 'number' ? { startTime } : {})
  }
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const body = await readBody(event).catch(() => ({}))
  const { force, from, to } = ontologyOverlaySchema.parse(body ?? {})
  const { window, first, count } = resolveWindow(from, to)

  const cached = readOverlay(orgId)
  // A cached blob only answers the window that produced it. Without this check
  // switching to a 7-day range would serve back the 30-day numbers under a
  // 7-day label — wrong in the most convincing possible way. The rolling
  // default matches on shape rather than on dates, since its dates come from
  // Pendo's timezone and the TTL already bounds how stale it can get.
  const sameWindow = window.relative
    ? cached?.window?.relative === true && cached.window.days === window.days
    : cached?.window?.relative !== true &&
      cached?.window?.from === window.from &&
      cached?.window?.to === window.to
  // The cached blob knows whether it was partial — it was computed with the
  // subscription's real timezone, which we can't determine here without asking
  // Pendo. Trusting that flag keeps "today" fresh without a probe request.
  const ttl = cached?.window?.partial ? PARTIAL_OVERLAY_TTL_MS : OVERLAY_TTL_MS
  if (cached && sameWindow && !force && Date.now() - new Date(cached.fetchedAt).getTime() < ttl) {
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

  const [features, pages, trackEvents] = await Promise.all([
    runUsage('featureEvents', orgId, appId, first, count),
    runUsage('pageEvents', orgId, appId, first, count),
    runUsage('trackEvents', orgId, appId, first, count)
  ])

  const metrics: OverlayMetrics['metrics'] = {}
  const errors: NonNullable<OverlayMetrics['errors']> = {}

  if ('rows' in features) {
    for (const r of features.rows) {
      const id = r.featureId != null ? String(r.featureId) : null
      if (id) metrics[`feature:${id}`] = { events: Number(r.events) || 0, visitors: Number(r.visitors) || 0 }
    }
  } else {
    errors.features = features.error
  }

  if ('rows' in pages) {
    for (const r of pages.rows) {
      const id = r.pageId != null ? String(r.pageId) : null
      if (id) metrics[`page:${id}`] = { events: Number(r.events) || 0, visitors: Number(r.visitors) || 0 }
    }
  } else {
    errors.pages = pages.error
  }

  if ('rows' in trackEvents) {
    for (const r of trackEvents.rows) {
      const id = r.trackTypeId != null ? String(r.trackTypeId) : null
      if (id) metrics[`trackEvent:${id}`] = { events: Number(r.events) || 0, visitors: Number(r.visitors) || 0 }
    }
  } else {
    errors.trackEvents = trackEvents.error
  }

  if ('error' in features && 'error' in pages && 'error' in trackEvents) {
    throw createError({ statusCode: 502, message: `Usage overlay failed: ${features.error}; ${pages.error}; ${trackEvents.error}` })
  }

  // Correct the provisional label with what Pendo says it actually queried, and
  // decide whether the window runs into the still-filling current day. Both need
  // the subscription's timezone, which only Pendo's echoed `startTime` reveals.
  const echoed = ('startTime' in features ? features.startTime : undefined)
    ?? ('startTime' in pages ? pages.startTime : undefined)
    ?? ('startTime' in trackEvents ? trackEvents.startTime : undefined)

  let finalWindow: OverlayWindow = window
  if (typeof echoed === 'number') {
    const described = window.relative
      ? { ...windowFromStartTime(echoed, count), relative: true }
      : window
    // The relative default stops at yesterday by construction; an explicit range
    // is partial whenever the user dragged it up to (or past) Pendo's today.
    const partial = !window.relative && described.to >= pendoToday(tzOffsetMs(echoed))
    finalWindow = partial ? { ...described, partial: true } : described
  }

  const overlay: OverlayMetrics = {
    fetchedAt: new Date().toISOString(),
    window: finalWindow,
    metrics,
    ...(Object.keys(errors).length ? { errors } : {})
  }
  writeOverlay(orgId, overlay)
  return { ...overlay, fromCache: false }
})
