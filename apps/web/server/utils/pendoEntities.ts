/**
 * Shared Pendo entity fetchers for the ontology sync. Direct REST calls with
 * the workspace integration key — the same pattern the /api/pendo/* lookup
 * endpoints use inline (those are intentionally left untouched; this module is
 * the shared home going forward).
 *
 * IMPORTANT: Pendo's `group` on features is an OBJECT `{id, name, ...}` in the
 * raw API (the aggregation source exposes `group.id` / `group.name` — see
 * examples/product_areas__usage_pages_features__last7d.dsl). Some responses
 * carry a plain string instead. Both shapes are normalized here.
 */

export interface PendoFeature {
  id: string
  name: string
  groupId?: string
  groupName?: string
  appId?: number
}

export interface PendoPage {
  id: string
  name: string
  url?: string
  appId?: number
}

export interface PendoSegment {
  id: string
  name: string
  description?: string
  appId?: number
}

/** A named custom event sent through Pendo's track API (`pendo.track()`). */
export interface PendoTrackEvent {
  id: string
  name: string
  appId?: number
}

const PENDO_BASE = 'https://app.pendo.io/api/v1'

/**
 * Query-param scoping per the Pendo OpenAPI spec
 * (github.com/Band-Aid/pendo-openapi): in multi-app subscriptions the bare
 * /feature and /page endpoints return only the DEFAULT app's entities.
 * `?appId=<id>` scopes to one app; `?expand=*` returns entities across ALL
 * apps (the documented way to discover which appIds exist). Observed live:
 * unscoped → 14 demo-app features; scoped → the real app's 51; expand=* → 68
 * across 4 apps.
 */
async function pendoGet(
  path: string,
  integrationKey: string,
  appId?: number,
  expandAll = false
): Promise<any[]> {
  const url = expandAll
    ? `${PENDO_BASE}/${path}?expand=*`
    : appId != null
      ? `${PENDO_BASE}/${path}?appId=${appId}`
      : `${PENDO_BASE}/${path}`
  const res = await fetch(url, {
    headers: {
      'x-pendo-integration-key': integrationKey,
      'content-type': 'application/json'
    }
  })
  if (!res.ok) {
    throw new Error(`Pendo ${path} fetch failed: HTTP ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

function normalizeGroup(group: unknown): { groupId?: string; groupName?: string } {
  if (group && typeof group === 'object') {
    const g = group as any
    const id = g.id != null ? String(g.id) : undefined
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : undefined
    return { groupId: id, groupName: name ?? id }
  }
  if (typeof group === 'string' && group.trim()) {
    // String shape: use the name itself as a stable id surrogate.
    return { groupId: group.trim(), groupName: group.trim() }
  }
  return {}
}

export async function fetchPendoFeatures(
  integrationKey: string,
  appId?: number,
  expandAll = false
): Promise<PendoFeature[]> {
  const raw = await pendoGet('feature', integrationKey, appId, expandAll)
  return raw
    .filter(f => f?.id != null)
    .map(f => ({
      id: String(f.id),
      name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : String(f.id),
      ...normalizeGroup(f.group),
      appId: f.appId != null ? Number(f.appId) : undefined
    }))
}

export async function fetchPendoPages(
  integrationKey: string,
  appId?: number,
  expandAll = false
): Promise<PendoPage[]> {
  const raw = await pendoGet('page', integrationKey, appId, expandAll)
  return raw
    .filter(p => p?.id != null)
    .map(p => ({
      id: String(p.id),
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : String(p.id),
      url: typeof p.url === 'string' ? p.url : undefined,
      appId: p.appId != null ? Number(p.appId) : undefined
    }))
}

export async function fetchPendoSegments(integrationKey: string): Promise<PendoSegment[]> {
  const raw = await pendoGet('segment', integrationKey)
  return raw
    .filter(s => s?.id != null)
    .map(s => ({
      id: String(s.id),
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : String(s.id),
      description: typeof s.description === 'string' ? s.description : undefined,
      appId: s.appId != null ? Number(s.appId) : undefined
    }))
}

/**
 * Pendo exposes the Track Event catalogue at `/tracktype`. Its `id` is the
 * `trackTypeId` required by the `trackEvents` aggregation source.
 */
export async function fetchPendoTrackEvents(
  integrationKey: string,
  appId?: number
): Promise<PendoTrackEvent[]> {
  const raw = await pendoGet('tracktype', integrationKey, appId)
  return raw
    .filter(t => t?.id != null)
    .map(t => ({
      id: String(t.id),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : String(t.id),
      appId: t.appId != null ? Number(t.appId) : undefined
    }))
}

/**
 * Validate an integration key via GET /token/verify (200 → valid, 403 → not).
 * Note: the live response uses `valid`/`writeAccess` field names.
 */
export async function verifyPendoKey(
  integrationKey: string
): Promise<{ valid: boolean; writeAccess?: boolean }> {
  const res = await fetch(`${PENDO_BASE}/token/verify`, {
    headers: { 'x-pendo-integration-key': integrationKey }
  })
  if (!res.ok) return { valid: false }
  try {
    const body = await res.json()
    return { valid: body?.valid !== false, writeAccess: Boolean(body?.writeAccess) }
  } catch {
    return { valid: true }
  }
}
