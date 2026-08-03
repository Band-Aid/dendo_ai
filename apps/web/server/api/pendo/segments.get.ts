import { getQuery } from 'h3'
import { readAdminState } from '~/server/utils/adminStore'

interface Segment {
  id: string
  name: string
  description?: string
  appId?: number
}

/**
 * List Pendo segments for the org. Mirrors `tools/pendo/lookup_segments.py` but proxies through
 * the server using the admin-configured integration key, so the browser never sees the key.
 * Optional `q` query param filters by case-insensitive name substring.
 */
export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const q = getQuery(event)
  const search = typeof q.q === 'string' ? q.q.toLowerCase() : ''
  const appIdParam = typeof q.appId === 'string' ? q.appId : undefined

  const state = await readAdminState(orgId)
  const apiKey = state.pendo?.integrationKey
  if (!apiKey) {
    throw createError({ statusCode: 400, message: 'Pendo integration key not configured. Set it in Admin → Pendo.' })
  }

  const url = new URL('https://app.pendo.io/api/v1/segment')
  if (appIdParam) url.searchParams.set('appId', appIdParam)

  const resp = await fetch(url.toString(), {
    headers: {
      'content-type': 'application/json',
      'x-pendo-integration-key': apiKey
    }
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw createError({ statusCode: resp.status, message: `Pendo segment lookup failed: ${text || resp.statusText}` })
  }

  const raw = await resp.json() as any[]
  const segments: Segment[] = raw.map(s => ({
    id: s.id,
    name: s.name ?? s.id,
    description: s.description,
    appId: s.appId
  }))

  const filtered = search ? segments.filter(s => s.name.toLowerCase().includes(search)) : segments
  return filtered
})
