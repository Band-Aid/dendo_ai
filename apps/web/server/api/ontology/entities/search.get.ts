import { getQuery } from 'h3'
import { readAdminState } from '~/server/utils/adminStore'
import { readOntology, entityNodeId } from '~/server/utils/ontologyStore'
import {
  fetchPendoFeatures,
  fetchPendoPages,
  fetchPendoSegments,
  fetchPendoTrackEvents
} from '~/server/utils/pendoEntities'

const MAX_PER_KIND = 10

/**
 * Live entity search against Pendo, for entities the synced map doesn't hold.
 * The structural sync truncates to per-kind caps (alphabetical), so anything
 * past a cap never appears in the local cache — this endpoint lets the concept
 * editor find those by name and offer them for registration.
 *
 * `cached` marks results already present as structural nodes so the client can
 * dedupe against its local options.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const q = getQuery(event)
  const search = typeof q.q === 'string' ? q.q.trim().toLowerCase() : ''
  if (search.length < 2) return { entities: [] }

  const state = await readAdminState(orgId)
  const integrationKey = state.pendo?.integrationKey
  if (!integrationKey) {
    throw createError({ statusCode: 400, message: 'Pendo API key not configured. Set it in Admin → Pendo Configuration.' })
  }

  const blob = readOntology(orgId)
  const cachedIds = new Set(blob.structural.nodes.map(n => n.id))
  const appId = blob.structural.effectiveAppId ?? state.pendo?.defaultAppId ?? undefined

  // Segments are subscription-wide (unscoped, same as sync). One failed source
  // degrades the search rather than killing it.
  const [features, pages, trackEvents, segments] = await Promise.allSettled([
    fetchPendoFeatures(integrationKey, appId),
    fetchPendoPages(integrationKey, appId),
    fetchPendoTrackEvents(integrationKey, appId),
    fetchPendoSegments(integrationKey)
  ])
  if (features.status === 'rejected' && pages.status === 'rejected' && trackEvents.status === 'rejected' && segments.status === 'rejected') {
    throw createError({ statusCode: 502, message: `Pendo entity search failed: ${features.reason?.message}` })
  }

  const matches = <T extends { name: string }>(r: PromiseSettledResult<T[]>) =>
    (r.status === 'fulfilled' ? r.value : [])
      .filter(e => e.name.toLowerCase().includes(search))
      .slice(0, MAX_PER_KIND)

  const entities = [
    ...matches(segments).map(s => ({
      kind: 'segment' as const,
      pendoId: s.id,
      name: s.name,
      description: s.description,
      appId: s.appId
    })),
    ...matches(features).map(f => ({
      kind: 'feature' as const,
      pendoId: f.id,
      name: f.name,
      appId: f.appId,
      groupId: f.groupId,
      groupName: f.groupName
    })),
    ...matches(pages).map(p => ({
      kind: 'page' as const,
      pendoId: p.id,
      name: p.name,
      url: p.url,
      appId: p.appId
    })),
    ...matches(trackEvents).map(t => ({
      kind: 'trackEvent' as const,
      pendoId: t.id,
      name: t.name,
      appId: t.appId
    }))
  ].map(e => {
    const id = entityNodeId(e.kind, e.pendoId)
    return { id, ...e, cached: cachedIds.has(id) }
  })

  return { entities }
})
