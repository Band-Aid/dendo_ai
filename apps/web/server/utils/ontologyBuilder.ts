import { createError } from 'h3'
import { readAdminState } from '~/server/utils/adminStore'
import {
  fetchPendoFeatures,
  fetchPendoPages,
  fetchPendoSegments
} from '~/server/utils/pendoEntities'
import { readOntology, writeOntology } from '~/server/utils/ontologyStore'
import type { OntologyBlob, OntologyEdge, OntologyEntityNode, OntologyStructural } from '~/types/ontology'

// Deterministic truncation caps — keep the blob and the graph render bounded.
const MAX_FEATURES = 300
const MAX_PAGES = 300
const MAX_SEGMENTS = 100

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

/**
 * Rebuild the structural layer from Pendo. Atomic: if any entity fetch fails
 * the blob is left untouched (502). Concepts are re-read from a FRESH
 * synchronous read after the network awaits, so a concept saved while the
 * fetches were in flight is never clobbered.
 */
export async function syncStructural(orgId: string): Promise<OntologyStructural> {
  const state = await readAdminState(orgId)
  const integrationKey = state.pendo?.integrationKey
  if (!integrationKey) {
    throw createError({ statusCode: 400, message: 'Pendo API key not configured. Set it in Admin → Pendo Configuration.' })
  }
  const defaultAppId = state.pendo?.defaultAppId

  // --- appId scoping ---------------------------------------------------------
  // Multi-app subscriptions: the bare /feature and /page endpoints return only
  // the DEFAULT app's entities — the configured app's entities require
  // `?appId=` (server-side scoping in pendoEntities). So: fetch scoped to the
  // configured id first; only if that comes back completely empty (a genuinely
  // wrong id) fall back to unscoped, adopt the dominant appId found, and
  // report the mismatch instead of producing an empty map.
  let features, pages, segments
  let effectiveAppId: number | undefined = defaultAppId ?? undefined
  let appIdMismatch: { configured: number; found: number[] } | undefined
  try {
    ;[features, pages, segments] = await Promise.all([
      fetchPendoFeatures(integrationKey, defaultAppId ?? undefined),
      fetchPendoPages(integrationKey, defaultAppId ?? undefined),
      fetchPendoSegments(integrationKey)
    ])

    if (defaultAppId != null && features.length === 0 && pages.length === 0) {
      // expand=* sees every app in the subscription — the bare unscoped call
      // only returns the default app and would misidentify the dominant appId.
      const [allFeatures, allPages] = await Promise.all([
        fetchPendoFeatures(integrationKey, undefined, true),
        fetchPendoPages(integrationKey, undefined, true)
      ])
      const appIdCounts = new Map<number, number>()
      for (const e of [...allFeatures, ...allPages]) {
        if (e.appId != null) appIdCounts.set(e.appId, (appIdCounts.get(e.appId) ?? 0) + 1)
      }
      if (appIdCounts.size > 0) {
        effectiveAppId = [...appIdCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        appIdMismatch = { configured: defaultAppId, found: [...appIdCounts.keys()] }
        features = allFeatures.filter(f => f.appId == null || f.appId === effectiveAppId)
        pages = allPages.filter(p => p.appId == null || p.appId === effectiveAppId)
      }
    }
  } catch (err: any) {
    throw createError({ statusCode: 502, message: `Ontology sync failed, nothing was changed: ${err.message}` })
  }

  // Fresh read → keep concepts saved during the fetches. Read before
  // truncation because concept measures pin entities past the caps: an entity
  // a concept references (e.g. picked via live search) must survive re-sync,
  // or the concept's measure edge dangles again.
  const fresh: OntologyBlob = readOntology(orgId)
  const referenced = new Set(fresh.concepts.flatMap(c => c.measures))
  const cap = <T extends { id: string; name: string }>(all: T[], max: number, prefix: string) => {
    const kept = all.sort(byName).slice(0, max)
    const keptIds = new Set(kept.map(e => e.id))
    return kept.concat(all.filter(e => !keptIds.has(e.id) && referenced.has(`${prefix}:${e.id}`)))
  }

  const truncated =
    features.length > MAX_FEATURES || pages.length > MAX_PAGES || segments.length > MAX_SEGMENTS
  features = cap(features, MAX_FEATURES, 'feature')
  pages = cap(pages, MAX_PAGES, 'page')
  segments = cap(segments, MAX_SEGMENTS, 'segment')

  const nodes: OntologyEntityNode[] = []
  const edges: OntologyEdge[] = []

  // Product-area nodes derived from distinct feature groups.
  const areas = new Map<string, string>() // groupId -> name
  for (const f of features) {
    if (f.groupId) areas.set(f.groupId, f.groupName ?? f.groupId)
  }
  for (const [groupId, name] of areas) {
    nodes.push({ id: `area:${groupId}`, kind: 'productArea', pendoId: groupId, name })
  }

  for (const f of features) {
    nodes.push({
      id: `feature:${f.id}`,
      kind: 'feature',
      pendoId: f.id,
      name: f.name,
      appId: f.appId,
      groupId: f.groupId
    })
    if (f.groupId) {
      edges.push({ from: `feature:${f.id}`, to: `area:${f.groupId}`, type: 'belongs_to' })
    }
  }
  for (const p of pages) {
    nodes.push({ id: `page:${p.id}`, kind: 'page', pendoId: p.id, name: p.name, appId: p.appId, url: p.url })
  }
  for (const s of segments) {
    nodes.push({ id: `segment:${s.id}`, kind: 'segment', pendoId: s.id, name: s.name, description: s.description, appId: s.appId })
  }

  const structural: OntologyStructural = {
    nodes,
    edges,
    syncedAt: new Date().toISOString(),
    truncated,
    counts: {
      productAreas: areas.size,
      features: features.length,
      pages: pages.length,
      segments: segments.length
    },
    effectiveAppId,
    appIdMismatch
  }

  writeOntology(orgId, { version: 1, structural, concepts: fresh.concepts })
  return structural
}
