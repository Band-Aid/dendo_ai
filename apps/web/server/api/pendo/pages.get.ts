import { readAdminState } from '~/server/utils/adminStore'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const adminState = await readAdminState(orgId)
  const { integrationKey, defaultAppId } = adminState.pendo
  
  if (!integrationKey) {
    throw createError({
      statusCode: 400,
      message: 'Pendo integration key not configured. Please set it in Admin settings.'
    })
  }
  
  try {
    // Get query params for filtering
    const query = getQuery(event)
    const limit = parseInt(query.limit as string) || 50
    const search = (query.search as string) || ''
    
    // Call Pendo REST API to get pages
    // Scope by appId server-side — the bare endpoint only returns the default
    // app's entities in multi-app subscriptions.
    const url = defaultAppId != null
      ? `https://app.pendo.io/api/v1/page?appId=${defaultAppId}`
      : 'https://app.pendo.io/api/v1/page'
    const response = await fetch(url, {
      headers: {
        'x-pendo-integration-key': integrationKey
      }
    })
    
    if (!response.ok) {
      throw new Error(`Pendo API returned ${response.status}: ${response.statusText}`)
    }
    
    const allPages = await response.json()
    
    // Filter by default app ID if configured
    let pages = allPages
    if (defaultAppId !== undefined) {
      pages = allPages.filter((p: any) => p.appId === defaultAppId)
    }
    
    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase()
      pages = pages.filter((p: any) => 
        (p.name || '').toLowerCase().includes(searchLower) ||
        (p.id || '').toLowerCase().includes(searchLower) ||
        (p.url || '').toLowerCase().includes(searchLower)
      )
    }
    
    // Sort by name for consistency
    pages.sort((a: any, b: any) => {
      const nameA = (a.name || a.id || '').toLowerCase()
      const nameB = (b.name || b.id || '').toLowerCase()
      return nameA.localeCompare(nameB)
    })
    
    // Apply limit
    const limited = pages.slice(0, limit)
    
    // Map to simplified format
    const formatted = limited.map((p: any) => ({
      id: p.id,
      name: p.name || p.id,
      url: p.url || '',
      appId: p.appId
    }))
    
    return { 
      pages: formatted,
      total: pages.length,
      showing: formatted.length,
      hasMore: pages.length > limit
    }
  } catch (error: any) {
    console.error('Failed to fetch Pendo pages:', error)
    throw createError({
      statusCode: 500,
      message: `Failed to fetch Pendo pages: ${error.message}`
    })
  }
})
